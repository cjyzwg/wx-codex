import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AppConfig } from "../config.js";
import { CodexBridge } from "../codex/codexBridge.js";
import type { InboundMessage, RuntimeState } from "../types.js";
import { AgentRuntime } from "../runtime/agentRuntime.js";
import { WechatStore } from "../store/wechatStore.js";

class MemoryStore extends WechatStore {
  private accounts: Array<{
    botToken: string;
    botId: string;
    userId: string;
    baseUrl: string;
    savedAt: number;
    label?: string;
  }> = [];
  private activeBotId: string | null = null;

  private state: RuntimeState = {
    updatesBuf: "",
    updatesBufByBot: {},
    contextTokens: {},
    lastMessageId: 0,
    lastMessageIdByBot: {},
    threadSessions: {},
    legacySharedThreadId: null,
    agentStatus: "stopped",
    codexStatus: "disconnected",
    lastError: null,
  };

  constructor() {
    super("memory");
  }

  override ensureDataDir(): void {}
  override getQrPngPath(): string { return "memory.png"; }
  override getQrTxtPath(): string { return "memory.txt"; }
  override loadAccounts() { return this.accounts.map((account) => ({ ...account })); }
  override loadAccount(botId?: string) {
    if (botId) {
      return this.accounts.find((account) => account.botId === botId) || null;
    }
    const active = this.accounts.find((account) => account.botId === this.activeBotId);
    return active ? { ...active } : this.accounts[0] ? { ...this.accounts[0] } : null;
  }
  override saveAccount(account: MemoryStore["accounts"][number]): void {
    const index = this.accounts.findIndex((item) => item.botId === account.botId);
    if (index >= 0) {
      this.accounts[index] = { ...account };
      this.activeBotId ??= account.botId;
      return;
    }
    this.accounts.push({ ...account });
    this.activeBotId ??= account.botId;
  }
  override updateAccountLabel(botId: string, label: string | null) {
    const index = this.accounts.findIndex((account) => account.botId === botId);
    if (index < 0) {
      return null;
    }
    this.accounts[index] = {
      ...this.accounts[index],
      label: label?.trim() ? label.trim() : undefined,
    };
    return { ...this.accounts[index] };
  }
  override setActiveBotId(botId: string | null): void {
    this.activeBotId = botId && this.accounts.some((account) => account.botId === botId) ? botId : this.accounts[0]?.botId || null;
  }
  override clearAccount(botId?: string): void {
    if (!botId) {
      this.accounts = [];
      this.activeBotId = null;
      return;
    }
    this.accounts = this.accounts.filter((account) => account.botId !== botId);
    if (this.activeBotId === botId) {
      this.activeBotId = this.accounts[0]?.botId || null;
    }
  }
  override loadState(): RuntimeState {
    return {
      ...this.state,
      contextTokens: { ...this.state.contextTokens },
      updatesBufByBot: { ...(this.state.updatesBufByBot || {}) },
      lastMessageIdByBot: { ...(this.state.lastMessageIdByBot || {}) },
      threadSessions: Object.fromEntries(
        Object.entries(this.state.threadSessions).map(([key, value]) => [
          key,
          {
            activeThreadId: value.activeThreadId,
            lastUsedAt: value.lastUsedAt,
            threads: value.threads.map((thread) => ({ ...thread })),
          },
        ]),
      ),
    };
  }
  override saveState(state: RuntimeState): void {
    this.state = {
      ...state,
      contextTokens: { ...state.contextTokens },
      updatesBufByBot: { ...(state.updatesBufByBot || {}) },
      lastMessageIdByBot: { ...(state.lastMessageIdByBot || {}) },
      threadSessions: Object.fromEntries(
        Object.entries(state.threadSessions).map(([key, value]) => [
          key,
          {
            activeThreadId: value.activeThreadId,
            lastUsedAt: value.lastUsedAt,
            threads: value.threads.map((thread) => ({ ...thread })),
          },
        ]),
      ),
    };
  }
  override loadQrState() { return null; }
  override saveQrState(): void {}
  override clearQrState(): void {}
  override readQrText() { return null; }
  override resetState(): RuntimeState {
    this.state = {
      updatesBuf: "",
      updatesBufByBot: {},
      contextTokens: {},
      lastMessageId: 0,
      lastMessageIdByBot: {},
      threadSessions: {},
      legacySharedThreadId: null,
      agentStatus: "stopped",
      codexStatus: "disconnected",
      lastError: null,
    };
    return this.loadState();
  }
}

function createConfig(): AppConfig {
  return {
    codexBin: "codex",
    dataDir: "memory",
    pollTimeoutMs: 10,
    typingIntervalMs: 10_000,
    systemPrompt: "system",
    logLevel: "info",
  };
}

function createWechatClient(store: MemoryStore) {
  return {
    getAccounts: () => store.loadAccounts(),
    getAccount: () => store.loadAccount(),
    setActiveBotId: (botId: string | null) => store.setActiveBotId(botId),
    getState: () => store.loadState(),
    saveState: (state: RuntimeState) => store.saveState(state),
    startQrLogin: vi.fn(),
    checkQrStatus: vi.fn(),
    clearLogin: vi.fn((botId?: string) => {
      if (botId) {
        store.clearAccount(botId);
        return store.loadState();
      }
      return store.resetState();
    }),
    pollMessages: vi.fn(async ({ signal }: { signal?: AbortSignal } = {}): Promise<InboundMessage[]> => {
      return new Promise((resolve) => {
        signal?.addEventListener("abort", () => resolve([]), { once: true });
        if (!signal) {
          resolve([]);
        }
      });
    }),
    sendTypingIndicator: vi.fn(async () => undefined),
    sendText: vi.fn(async () => undefined),
    sendLocalFile: vi.fn(async () => undefined),
  };
}

function createCodexBridge(overrides: Record<string, unknown> = {}) {
  return {
    connect: vi.fn(async () => undefined),
    ensureThread: vi.fn(async (threadId: string | null) => threadId || "thread-123"),
    activateThread: vi.fn(async (threadId: string) => threadId),
    createThread: vi.fn(async () => "thread-new"),
    runTurn: vi.fn(async () => ({ replyText: "done", streamedAny: false, finalAlreadyStreamed: false })),
    disconnect: vi.fn(async () => undefined),
    resetSharedThread: vi.fn(async () => undefined),
    reconnect: vi.fn(async (threadId: string | null) => threadId),
    ...overrides,
  };
}

function saveAccount(store: MemoryStore): void {
  store.saveAccount({
    botToken: "token",
    botId: "bot-id",
    userId: "self-id",
    baseUrl: "https://example.com",
    savedAt: Date.now(),
  });
}

function saveSecondAccount(store: MemoryStore): void {
  store.saveAccount({
    botToken: "token-b",
    botId: "bot-b",
    userId: "self-b",
    baseUrl: "https://example-b.com",
    savedAt: Date.now() + 1,
  });
}

function message(input: Partial<InboundMessage> = {}): InboundMessage {
  return {
    messageId: 1,
    botId: "bot-id",
    fromUserId: "user-a",
    toUserId: "bot-id",
    text: "hello world",
    ...input,
  };
}

function getHandleSingleMessage(runtime: AgentRuntime): (message: InboundMessage) => Promise<void> {
  return (runtime as unknown as { handleSingleMessage: (message: InboundMessage) => Promise<void> }).handleSingleMessage.bind(runtime);
}

function setThreadSession(
  store: MemoryStore,
  userId: string,
  threads: Array<{
    threadId: string;
    createdAt: number;
    lastUsedAt: number;
    displayCwd?: string | null;
    cwdSource?: string;
  }>,
  activeThreadId: string,
): void {
  const state = store.loadState();
  state.threadSessions[`bot-id:${userId}`] = {
    activeThreadId,
    lastUsedAt: threads[threads.length - 1]?.lastUsedAt ?? null,
    threads: threads.map((thread) => ({
      threadId: thread.threadId,
      createdAt: thread.createdAt,
      lastUsedAt: thread.lastUsedAt,
      displayCwd: thread.displayCwd ?? null,
      cwdSource: thread.cwdSource ?? "unknown",
    })),
  };
  store.saveState(state);
}

describe("AgentRuntime", () => {
  beforeEach(() => {
    vi.spyOn(CodexBridge, "detectAvailability").mockReturnValue({ available: true, version: "0.1.0", error: null });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps user identity in the formatted per-user-thread prompt flow", async () => {
    const store = new MemoryStore();
    saveAccount(store);

    const turns: string[] = [];
    const wechatClient = createWechatClient(store);
    const codexBridge = createCodexBridge({
      runTurn: vi.fn(async (prompt: string) => {
        turns.push(prompt);
        return { replyText: "done", streamedAny: false, finalAlreadyStreamed: false };
      }),
    });

    const runtime = new AgentRuntime(createConfig(), {
      store,
      wechatClient: wechatClient as never,
      codexBridge: codexBridge as never,
    });

    await runtime.initialize();
    await getHandleSingleMessage(runtime)(message());

    expect(codexBridge.ensureThread).toHaveBeenCalledWith(null);
    expect(store.loadState().threadSessions["bot-id:user-a"]?.activeThreadId).toBe("thread-123");
    expect(turns[0]).toContain("来自用户 user-a");
    expect(turns[0]).toContain("hello world");
  });

  it("isolates thread sessions for the same WeChat user across different bots", async () => {
    const store = new MemoryStore();
    saveAccount(store);
    saveSecondAccount(store);

    const turns: string[] = [];
    const wechatClient = createWechatClient(store);
    const codexBridge = createCodexBridge({
      ensureThread: vi
        .fn()
        .mockResolvedValueOnce("thread-bot-a")
        .mockResolvedValueOnce("thread-bot-b"),
      runTurn: vi.fn(async (prompt: string) => {
        turns.push(prompt);
        return { replyText: "done", streamedAny: false, finalAlreadyStreamed: false };
      }),
    });

    const runtime = new AgentRuntime(createConfig(), {
      store,
      wechatClient: wechatClient as never,
      codexBridge: codexBridge as never,
    });

    await runtime.initialize();
    const handleSingleMessage = getHandleSingleMessage(runtime);
    await handleSingleMessage(message({ botId: "bot-id", fromUserId: "shared-user", text: "bot a hi" }));
    await handleSingleMessage(message({ botId: "bot-b", fromUserId: "shared-user", text: "bot b hi" }));

    expect(store.loadState().threadSessions["bot-id:shared-user"]?.activeThreadId).toBe("thread-bot-a");
    expect(store.loadState().threadSessions["bot-b:shared-user"]?.activeThreadId).toBe("thread-bot-b");
    expect(turns[0]).toContain("shared-user");
    expect(turns[1]).toContain("shared-user");
  });

  it("records codex errors when availability is missing", async () => {
    vi.spyOn(CodexBridge, "detectAvailability").mockReturnValue({ available: false, version: null, error: "missing codex" });

    const runtime = new AgentRuntime(createConfig(), {
      store: new MemoryStore(),
    });

    await runtime.initialize();
    expect(runtime.getSnapshot().codex.status).toBe("error");
  });

  it("normalizes stale persisted running state to stopped on startup", async () => {
    const store = new MemoryStore();
    const stale = store.loadState();
    stale.agentStatus = "running";
    stale.codexStatus = "idle";
    stale.threadSessions["bot-id:user-stale"] = {
      activeThreadId: "thread-stale",
      lastUsedAt: 123,
      threads: [{ threadId: "thread-stale", createdAt: 123, lastUsedAt: 123, displayCwd: null, cwdSource: "unknown" }],
    };
    store.saveState(stale);

    const runtime = new AgentRuntime(createConfig(), {
      store,
    });

    await runtime.initialize();

    const snapshot = runtime.getSnapshot();
    expect(snapshot.agent.status).toBe("stopped");
    expect(snapshot.codex.status).toBe("disconnected");
    expect(store.loadState().agentStatus).toBe("stopped");
    expect(store.loadState().codexStatus).toBe("disconnected");
    expect(store.loadState().threadSessions["bot-id:user-stale"]?.activeThreadId).toBe("thread-stale");
  });

  it("auto starts when login state exists without sending a proactive WeChat ready message", async () => {
    const store = new MemoryStore();
    saveAccount(store);

    const wechatClient = createWechatClient(store);
    const codexBridge = createCodexBridge();

    const runtime = new AgentRuntime(createConfig(), {
      store,
      wechatClient: wechatClient as never,
      codexBridge: codexBridge as never,
    });

    await runtime.initialize();
    await runtime.autoStartIfPossible();

    expect(codexBridge.connect).toHaveBeenCalledTimes(1);
    expect(wechatClient.sendText).not.toHaveBeenCalled();
    expect(runtime.getSnapshot().agent.status).toBe("running");
    await runtime.stop();
  });

  it("does not attempt a startup ready message even when cached context tokens exist", async () => {
    const store = new MemoryStore();
    saveAccount(store);
    const state = store.loadState();
    state.contextTokens["bot-id:user-x"] = "ctx-x";
    state.contextTokens["bot-id:user-y"] = "ctx-y";
    store.saveState(state);

    const wechatClient = createWechatClient(store);
    const codexBridge = createCodexBridge();

    const runtime = new AgentRuntime(createConfig(), {
      store,
      wechatClient: wechatClient as never,
      codexBridge: codexBridge as never,
    });

    await runtime.initialize();
    await runtime.autoStartIfPossible();

    expect(wechatClient.sendText).not.toHaveBeenCalled();
    await runtime.stop();
  });

  it("logs out only the active WeChat bot and preserves the others", async () => {
    const store = new MemoryStore();
    saveAccount(store);
    saveSecondAccount(store);
    const state = store.loadState();
    state.contextTokens["bot-id:user-a"] = "ctx-a";
    state.contextTokens["bot-b:user-b"] = "ctx-b";
    state.threadSessions["bot-id:user-a"] = {
      activeThreadId: "thread-a",
      lastUsedAt: 1,
      threads: [{ threadId: "thread-a", createdAt: 1, lastUsedAt: 1, displayCwd: null, cwdSource: "unknown" }],
    };
    state.threadSessions["bot-b:user-b"] = {
      activeThreadId: "thread-b",
      lastUsedAt: 2,
      threads: [{ threadId: "thread-b", createdAt: 2, lastUsedAt: 2, displayCwd: null, cwdSource: "unknown" }],
    };
    store.saveState(state);

    const wechatClient = createWechatClient(store);
    const codexBridge = createCodexBridge();
    const runtime = new AgentRuntime(createConfig(), {
      store,
      wechatClient: wechatClient as never,
      codexBridge: codexBridge as never,
    });

    await runtime.initialize();
    await runtime.logoutActiveWechat();

    expect(store.loadAccounts().map((account) => account.botId)).toEqual(["bot-b"]);
    expect(store.loadState().contextTokens["bot-id:user-a"]).toBeUndefined();
    expect(store.loadState().contextTokens["bot-b:user-b"]).toBe("ctx-b");
    expect(store.loadState().threadSessions["bot-id:user-a"]).toBeUndefined();
    expect(store.loadState().threadSessions["bot-b:user-b"]?.activeThreadId).toBe("thread-b");
    expect(runtime.getSnapshot().wechat.activeBotId).toBe("bot-b");
  });

  it("cycles the active WeChat bot and uses the selected one for removal", async () => {
    const store = new MemoryStore();
    saveAccount(store);
    saveSecondAccount(store);

    const runtime = new AgentRuntime(createConfig(), {
      store,
      wechatClient: createWechatClient(store) as never,
      codexBridge: createCodexBridge() as never,
    });

    await runtime.initialize();

    expect(runtime.getSnapshot().wechat.activeBotId).toBe("bot-id");

    runtime.cycleActiveWechatBot();
    expect(runtime.getSnapshot().wechat.activeBotId).toBe("bot-b");

    runtime.cycleActiveWechatBot();
    expect(runtime.getSnapshot().wechat.activeBotId).toBe("bot-id");

    runtime.cycleActiveWechatBot();
    await runtime.logoutActiveWechat();
    expect(store.loadAccounts().map((account) => account.botId)).toEqual(["bot-id"]);
  });

  it("automatically refreshes the QR code when the server marks it expired", async () => {
    const store = new MemoryStore();
    const wechatClient = createWechatClient(store);
    wechatClient.startQrLogin.mockResolvedValueOnce({
      qrStatus: "wait",
      qrText: "QR-1",
      qrPath: "/tmp/qr-1.png",
      qrUrl: "https://example.com/qr-1.png",
    });
    wechatClient.checkQrStatus.mockResolvedValueOnce({ status: "expired" });
    wechatClient.startQrLogin.mockResolvedValueOnce({
      qrStatus: "wait",
      qrText: "QR-2",
      qrPath: "/tmp/qr-2.png",
      qrUrl: "https://example.com/qr-2.png",
    });

    const runtime = new AgentRuntime(createConfig(), {
      store,
      wechatClient: wechatClient as never,
      codexBridge: createCodexBridge() as never,
    });

    await runtime.initialize();
    await runtime.beginWechatLogin(false);
    await (runtime as unknown as { pollQrStatus: () => Promise<void> }).pollQrStatus();

    expect(wechatClient.startQrLogin).toHaveBeenNthCalledWith(1, false);
    expect(wechatClient.startQrLogin).toHaveBeenNthCalledWith(2, true);
    expect(runtime.getSnapshot().wechat.qrStatus).toBe("wait");
    expect(runtime.getSnapshot().wechat.qrUrl).toBe("https://example.com/qr-2.png");
  });

  it("renames the active bot with /botname and exposes the label in the snapshot", async () => {
    const store = new MemoryStore();
    saveAccount(store);

    const wechatClient = createWechatClient(store);
    const runtime = new AgentRuntime(createConfig(), {
      store,
      wechatClient: wechatClient as never,
      codexBridge: createCodexBridge() as never,
    });

    await runtime.initialize();
    await getHandleSingleMessage(runtime)(message({ text: "/botname 主微信" }));

    expect(store.loadAccount("bot-id")?.label).toBe("主微信");
    expect(runtime.getSnapshot().wechat.activeBotId).toBe("bot-id");
    expect(runtime.getSnapshot().wechat.bots[0]?.label).toBe("主微信");
    expect(wechatClient.sendText).toHaveBeenCalledWith("user-a", expect.stringContaining("主微信"), undefined, "bot-id");
  });

  it("shows the current bot label and can clear it with /botname clear", async () => {
    const store = new MemoryStore();
    saveAccount(store);
    store.updateAccountLabel("bot-id", "主微信");

    const wechatClient = createWechatClient(store);
    const runtime = new AgentRuntime(createConfig(), {
      store,
      wechatClient: wechatClient as never,
      codexBridge: createCodexBridge() as never,
    });

    await runtime.initialize();
    const handleSingleMessage = getHandleSingleMessage(runtime);

    await handleSingleMessage(message({ text: "/botname" }));
    expect(wechatClient.sendText).toHaveBeenCalledWith("user-a", "当前微信账号备注：主微信", undefined, "bot-id");

    await handleSingleMessage(message({ text: "/botname clear" }));
    expect(store.loadAccount("bot-id")?.label).toBeUndefined();
    expect(wechatClient.sendText).toHaveBeenCalledWith("user-a", "已清空当前微信账号备注名。", undefined, "bot-id");
  });

  it("creates a new active thread when the sender sends /new", async () => {
    const store = new MemoryStore();
    saveAccount(store);

    const wechatClient = createWechatClient(store);
    const codexBridge = createCodexBridge({
      createThread: vi.fn(async () => "thread-fresh"),
    });

    const runtime = new AgentRuntime(createConfig(), {
      store,
      wechatClient: wechatClient as never,
      codexBridge: codexBridge as never,
    });

    await runtime.initialize();
    await getHandleSingleMessage(runtime)(message({ text: "/new" }));

    expect(codexBridge.createThread).toHaveBeenCalledTimes(1);
    expect(store.loadState().threadSessions["bot-id:user-a"]?.activeThreadId).toBe("thread-fresh");
    expect(
      (store.loadState().threadSessions["bot-id:user-a"]?.threads[0] as {
        displayCwd?: string | null;
        cwdSource?: string;
      })?.displayCwd,
    ).toBe(process.cwd());
    expect(
      (store.loadState().threadSessions["bot-id:user-a"]?.threads[0] as {
        displayCwd?: string | null;
        cwdSource?: string;
      })?.cwdSource,
    ).toBe("created_here");
    expect(wechatClient.sendText).toHaveBeenCalledWith("user-a", expect.stringContaining("已切换到新会话"), undefined, "bot-id");
    expect((runtime.getSnapshot().codex as { threadCwd?: string | null }).threadCwd).toBe(process.cwd());
    expect(codexBridge.runTurn).not.toHaveBeenCalled();
  });

  it("lists known threads when the sender sends /threads", async () => {
    const store = new MemoryStore();
    saveAccount(store);
    setThreadSession(
      store,
      "user-a",
      [
        { threadId: "thread-1", createdAt: 1, lastUsedAt: 1, displayCwd: "/repo/alpha", cwdSource: "created_here" },
        { threadId: "thread-2", createdAt: 2, lastUsedAt: 2, displayCwd: null, cwdSource: "attached_external" },
      ],
      "thread-2",
    );

    const wechatClient = createWechatClient(store);
    const codexBridge = createCodexBridge();
    const runtime = new AgentRuntime(createConfig(), {
      store,
      wechatClient: wechatClient as never,
      codexBridge: codexBridge as never,
    });

    await runtime.initialize();
    await getHandleSingleMessage(runtime)(message({ text: "/threads" }));

    expect(wechatClient.sendText).toHaveBeenCalledWith("user-a", expect.stringContaining("1."), undefined, "bot-id");
    expect(wechatClient.sendText).toHaveBeenCalledWith("user-a", expect.stringContaining("2."), undefined, "bot-id");
    expect(wechatClient.sendText).toHaveBeenCalledWith("user-a", expect.stringContaining("cwd: /repo/alpha"), undefined, "bot-id");
    expect(wechatClient.sendText).toHaveBeenCalledWith("user-a", expect.stringContaining("cwd: unknown (external thread)"), undefined, "bot-id");
    expect(codexBridge.runTurn).not.toHaveBeenCalled();
  });

  it("switches the sender to the selected thread when /use 2 is received", async () => {
    const store = new MemoryStore();
    saveAccount(store);
    setThreadSession(
      store,
      "user-a",
      [
        { threadId: "thread-1", createdAt: 1, lastUsedAt: 1 },
        { threadId: "thread-2", createdAt: 2, lastUsedAt: 2 },
      ],
      "thread-1",
    );

    const wechatClient = createWechatClient(store);
    const codexBridge = createCodexBridge();
    const runtime = new AgentRuntime(createConfig(), {
      store,
      wechatClient: wechatClient as never,
      codexBridge: codexBridge as never,
    });

    await runtime.initialize();
    await getHandleSingleMessage(runtime)(message({ text: "/use 2" }));

    expect(store.loadState().threadSessions["bot-id:user-a"]?.activeThreadId).toBe("thread-2");
    expect(wechatClient.sendText).toHaveBeenCalledWith("user-a", expect.stringContaining("thread-2"), undefined, "bot-id");
    expect(codexBridge.runTurn).not.toHaveBeenCalled();
  });

  it("switches the sender when /use targets a unique thread suffix", async () => {
    const store = new MemoryStore();
    saveAccount(store);
    setThreadSession(
      store,
      "user-a",
      [
        { threadId: "thread-alpha-1234", createdAt: 1, lastUsedAt: 1 },
        { threadId: "thread-beta-5678", createdAt: 2, lastUsedAt: 2 },
      ],
      "thread-alpha-1234",
    );

    const wechatClient = createWechatClient(store);
    const codexBridge = createCodexBridge();
    const runtime = new AgentRuntime(createConfig(), {
      store,
      wechatClient: wechatClient as never,
      codexBridge: codexBridge as never,
    });

    await runtime.initialize();
    await getHandleSingleMessage(runtime)(message({ text: "/use 5678" }));

    expect(store.loadState().threadSessions["bot-id:user-a"]?.activeThreadId).toBe("thread-beta-5678");
    expect(wechatClient.sendText).toHaveBeenCalledWith("user-a", expect.stringContaining("thread-beta-5678"), undefined, "bot-id");
  });

  it("attaches an existing codex thread id even when it is not already in the local thread list", async () => {
    const store = new MemoryStore();
    saveAccount(store);

    const wechatClient = createWechatClient(store);
    const codexBridge = createCodexBridge({
      activateThread: vi.fn(async (threadId: string) => threadId),
    });
    const runtime = new AgentRuntime(createConfig(), {
      store,
      wechatClient: wechatClient as never,
      codexBridge: codexBridge as never,
    });

    await runtime.initialize();
    await getHandleSingleMessage(runtime)(message({ text: "/use external-thread-abc123" }));

    expect(codexBridge.activateThread).toHaveBeenCalledWith("external-thread-abc123");
    expect(store.loadState().threadSessions["bot-id:user-a"]?.activeThreadId).toBe("external-thread-abc123");
    expect(
      (store.loadState().threadSessions["bot-id:user-a"]?.threads[0] as {
        displayCwd?: string | null;
        cwdSource?: string;
      })?.displayCwd,
    ).toBeNull();
    expect(
      (store.loadState().threadSessions["bot-id:user-a"]?.threads[0] as {
        displayCwd?: string | null;
        cwdSource?: string;
      })?.cwdSource,
    ).toBe("attached_external");
    expect(wechatClient.sendText).toHaveBeenCalledWith("user-a", expect.stringContaining("external-thread-abc123"), undefined, "bot-id");
    expect((runtime.getSnapshot().codex as { threadCwd?: string | null }).threadCwd).toBe("unknown (external thread)");
  });

  it("attaches an external codex thread with a manually assigned cwd from /use --cwd", async () => {
    const store = new MemoryStore();
    saveAccount(store);

    const wechatClient = createWechatClient(store);
    const codexBridge = createCodexBridge({
      activateThread: vi.fn(async (threadId: string) => threadId),
    });

    const runtime = new AgentRuntime(createConfig(), {
      store,
      wechatClient: wechatClient as never,
      codexBridge: codexBridge as never,
    });

    await runtime.initialize();
    await getHandleSingleMessage(runtime)(message({ text: "/use external-thread-xyz --cwd /repo/external" }));

    const thread = store.loadState().threadSessions["bot-id:user-a"]?.threads[0] as {
      displayCwd?: string | null;
      cwdSource?: string;
    };
    expect(thread?.displayCwd).toBe("/repo/external");
    expect(thread?.cwdSource).toBe("attached_external");
    expect((runtime.getSnapshot().codex as { threadCwd?: string | null }).threadCwd).toBe("/repo/external");
    expect(wechatClient.sendText).toHaveBeenCalledWith("user-a", expect.stringContaining("cwd: /repo/external"), undefined, "bot-id");
  });

  it("exposes the active thread cwd in the codex snapshot for the tui", async () => {
    const store = new MemoryStore();
    saveAccount(store);
    setThreadSession(
      store,
      "user-a",
      [
        { threadId: "thread-1", createdAt: 1, lastUsedAt: 1, displayCwd: "/repo/one", cwdSource: "created_here" },
        { threadId: "thread-2", createdAt: 2, lastUsedAt: 2, displayCwd: null, cwdSource: "attached_external" },
      ],
      "thread-2",
    );

    const runtime = new AgentRuntime(createConfig(), {
      store,
      wechatClient: createWechatClient(store) as never,
      codexBridge: createCodexBridge() as never,
    });

    await runtime.initialize();

    expect(runtime.getSnapshot().codex.threadId).toBe("thread-2");
    expect((runtime.getSnapshot().codex as { threadCwd?: string | null }).threadCwd).toBe("unknown (external thread)");
  });

  it("lists a manually assigned cwd for an attached external thread in /threads", async () => {
    const store = new MemoryStore();
    saveAccount(store);
    setThreadSession(
      store,
      "user-a",
      [{ threadId: "external-thread-xyz", createdAt: 1, lastUsedAt: 1, displayCwd: "/repo/external", cwdSource: "attached_external" }],
      "external-thread-xyz",
    );

    const runtime = new AgentRuntime(createConfig(), {
      store,
      wechatClient: createWechatClient(store) as never,
      codexBridge: createCodexBridge() as never,
    });

    await runtime.initialize();
    await getHandleSingleMessage(runtime)(message({ text: "/threads" }));

    const wechatClient = runtime as unknown as { wechatClient: { sendText: ReturnType<typeof vi.fn> } };
    expect(wechatClient.wechatClient.sendText).toHaveBeenCalledWith("user-a", expect.stringContaining("cwd: /repo/external"), undefined, "bot-id");
  });

  it("replies directly for unsupported message types without calling codex", async () => {
    const store = new MemoryStore();
    saveAccount(store);

    const wechatClient = createWechatClient(store);
    const codexBridge = createCodexBridge();

    const runtime = new AgentRuntime(createConfig(), {
      store,
      wechatClient: wechatClient as never,
      codexBridge: codexBridge as never,
    });

    await runtime.initialize();
    await getHandleSingleMessage(runtime)(message({
      messageId: 2,
      fromUserId: "user-b",
      text: "[Unsupported video message]",
      directReplyText: "该消息类型不支持",
    }));

    expect(wechatClient.sendText).toHaveBeenCalledWith("user-b", "该消息类型不支持", undefined, "bot-id");
    expect(codexBridge.runTurn).not.toHaveBeenCalled();
  });

  it("labels voice transcription turns before sending them to codex", async () => {
    const store = new MemoryStore();
    saveAccount(store);

    const turns: string[] = [];
    const wechatClient = createWechatClient(store);
    const codexBridge = createCodexBridge({
      runTurn: vi.fn(async (prompt: string) => {
        turns.push(prompt);
        return { replyText: "done", streamedAny: false, finalAlreadyStreamed: false };
      }),
    });

    const runtime = new AgentRuntime(createConfig(), {
      store,
      wechatClient: wechatClient as never,
      codexBridge: codexBridge as never,
    });

    await runtime.initialize();
    await getHandleSingleMessage(runtime)(
      message({
        messageId: 21,
        fromUserId: "user-v",
        text: "帮我总结一下",
        voice: {
          transcript: "帮我总结一下",
          durationMs: 3200,
          sampleRate: 16000,
        },
      }),
    );

    expect(turns[0]).toContain("语音转写");
    expect(turns[0]).toContain("帮我总结一下");
  });

  it("holds image or file messages until the next text message and then sends a type-aware combined prompt to codex", async () => {
    const store = new MemoryStore();
    saveAccount(store);

    const turns: string[] = [];
    const wechatClient = createWechatClient(store);
    const codexBridge = createCodexBridge({
      runTurn: vi.fn(async (prompt: string) => {
        turns.push(prompt);
        return { replyText: "done", streamedAny: false, finalAlreadyStreamed: false };
      }),
    });

    const runtime = new AgentRuntime(createConfig(), {
      store,
      wechatClient: wechatClient as never,
      codexBridge: codexBridge as never,
    });

    await runtime.initialize();
    const handleSingleMessage = getHandleSingleMessage(runtime);

    await handleSingleMessage(message({
      messageId: 3,
      fromUserId: "user-c",
      text: "",
      media: [{ kind: "image", path: "C:\\temp\\image.jpg", source: "item", contentType: "image/jpeg" }],
    }));

    expect(wechatClient.sendText).toHaveBeenCalledWith("user-c", "已经收到你的图片了，请问你要我做什么？", undefined, "bot-id");
    expect(codexBridge.runTurn).not.toHaveBeenCalled();

    await handleSingleMessage(message({
      messageId: 4,
      fromUserId: "user-c",
      text: "帮我分析一下这张图",
    }));

    expect(codexBridge.runTurn).toHaveBeenCalledTimes(1);
    expect(turns[0]).toContain("来自用户 user-c");
    expect(turns[0]).toContain("用户先发送了图片，请结合这些内容回答。");
    expect(turns[0]).toContain("图片路径: C:\\temp\\image.jpg");
    expect(turns[0]).toContain("帮我分析一下这张图");
    expect(turns[0]).not.toContain("[Image saved:");
  });

  it("buffers codex streamed text and sends one combined WeChat reply when the turn completes", async () => {
    const store = new MemoryStore();
    saveAccount(store);

    const wechatClient = createWechatClient(store);
    const codexBridge = createCodexBridge({
      runTurn: vi.fn(async (_prompt: string, options?: { onText?: (text: string, meta?: { isFinal: boolean }) => Promise<void> | void }) => {
        for (let index = 1; index <= 12; index += 1) {
          await options?.onText?.(`第${index}句。`, { isFinal: index === 12 });
        }
        return { replyText: "第12句。", streamedAny: true, finalAlreadyStreamed: true };
      }),
    });

    const runtime = new AgentRuntime(createConfig(), {
      store,
      wechatClient: wechatClient as never,
      codexBridge: codexBridge as never,
    });

    await runtime.initialize();
    await getHandleSingleMessage(runtime)(message({
      messageId: 5,
      fromUserId: "user-d",
      text: "你好",
    }));

    expect(wechatClient.sendText).toHaveBeenCalledTimes(1);
    expect(wechatClient.sendText).toHaveBeenCalledWith(
      "user-d",
      "第1句。\n第2句。\n第3句。\n第4句。\n第5句。\n第6句。\n第7句。\n第8句。\n第9句。\n第10句。\n第11句。\n第12句。",
      undefined,
      "bot-id",
    );
  });

  it("keeps a multiline streamed paragraph in one WeChat message", async () => {
    const store = new MemoryStore();
    saveAccount(store);

    const wechatClient = createWechatClient(store);
    const codexBridge = createCodexBridge({
      runTurn: vi.fn(async (_prompt: string, options?: { onText?: (text: string) => Promise<void> | void }) => {
        await options?.onText?.("当前这个项目根目录下主要有这些目录：\n- dist\n- happy\n- src");
        return { replyText: "当前这个项目根目录下主要有这些目录：\n- dist\n- happy\n- src", streamedAny: true, finalAlreadyStreamed: true };
      }),
    });

    const runtime = new AgentRuntime(createConfig(), {
      store,
      wechatClient: wechatClient as never,
      codexBridge: codexBridge as never,
    });

    await runtime.initialize();
    await getHandleSingleMessage(runtime)(message({
      messageId: 6,
      fromUserId: "user-e",
      text: "看一下都有什么目录",
    }));

    expect(wechatClient.sendText).toHaveBeenCalledTimes(1);
    expect(wechatClient.sendText).toHaveBeenCalledWith("user-e", "当前这个项目根目录下主要有这些目录：\n- dist\n- happy\n- src", undefined, "bot-id");
  });

  it("splits an overlong final reply into a few natural WeChat messages", async () => {
    const store = new MemoryStore();
    saveAccount(store);

    const wechatClient = createWechatClient(store);
    const longReply = Array.from({ length: 90 }, (_value, index) => `第${index + 1}段说明。`).join("\n");
    const codexBridge = createCodexBridge({
      runTurn: vi.fn(async (_prompt: string, options?: { onText?: (text: string, meta?: { isFinal: boolean }) => Promise<void> | void }) => {
        await options?.onText?.(longReply, { isFinal: true });
        return { replyText: longReply, streamedAny: true, finalAlreadyStreamed: true };
      }),
    });

    const runtime = new AgentRuntime(createConfig(), {
      store,
      wechatClient: wechatClient as never,
      codexBridge: codexBridge as never,
    });

    await runtime.initialize();
    await getHandleSingleMessage(runtime)(message({
      messageId: 6,
      fromUserId: "user-split",
      text: "给我长回复",
    }));

    expect(wechatClient.sendText.mock.calls.length).toBeGreaterThan(1);
    expect(wechatClient.sendText.mock.calls.length).toBeLessThan(10);
    expect(wechatClient.sendText.mock.calls.every((call) => typeof call[1] === "string" && call[1].length <= 500)).toBe(true);
  });

  it("sends local files back to WeChat when codex emits wx_send markers", async () => {
    const store = new MemoryStore();
    saveAccount(store);

    const wechatClient = createWechatClient(store);
    const codexBridge = createCodexBridge({
      runTurn: vi.fn(async (_prompt: string, options?: { onText?: (text: string, meta: { isFinal: boolean }) => Promise<void> | void }) => {
        await options?.onText?.("分析完成。\n[[wx_send:/tmp/report.txt]]", { isFinal: true });
        return { replyText: "分析完成。\n[[wx_send:/tmp/report.txt]]", streamedAny: true, finalAlreadyStreamed: true };
      }),
    });

    const runtime = new AgentRuntime(createConfig(), {
      store,
      wechatClient: wechatClient as never,
      codexBridge: codexBridge as never,
    });

    await runtime.initialize();
    await getHandleSingleMessage(runtime)(message({
      messageId: 7,
      fromUserId: "user-f",
      text: "把结果发我",
    }));

    expect(wechatClient.sendText).toHaveBeenCalledWith("user-f", "分析完成。", undefined, "bot-id");
    expect(wechatClient.sendLocalFile).toHaveBeenCalledWith("user-f", "/tmp/report.txt", undefined, "bot-id");
    expect(wechatClient.sendText).not.toHaveBeenCalledWith("user-f", expect.stringContaining("[[wx_send:"));
  });

  it("uses the current inbound message context token instead of the latest cached token when replying", async () => {
    const store = new MemoryStore();
    saveAccount(store);

    const state = store.loadState();
    state.contextTokens["bot-id:user-g"] = "ctx-latest-cached";
    store.saveState(state);

    const wechatClient = createWechatClient(store);
    const codexBridge = createCodexBridge({
      runTurn: vi.fn(async () => ({ replyText: "当前这条消息的回复", streamedAny: false, finalAlreadyStreamed: false })),
    });

    const runtime = new AgentRuntime(createConfig(), {
      store,
      wechatClient: wechatClient as never,
      codexBridge: codexBridge as never,
    });

    await runtime.initialize();
    await getHandleSingleMessage(runtime)(message({
      messageId: 8,
      fromUserId: "user-g",
      text: "排队消息",
      contextToken: "ctx-current-turn",
    }));

    expect(wechatClient.sendTypingIndicator).toHaveBeenCalledWith("user-g", "typing", "ctx-current-turn", "bot-id");
    expect(wechatClient.sendText).toHaveBeenCalledWith("user-g", "当前这条消息的回复", "ctx-current-turn", "bot-id");
  });
});
