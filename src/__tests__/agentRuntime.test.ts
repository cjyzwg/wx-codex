import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AppConfig } from "../config.js";
import { CodexBridge } from "../codex/codexBridge.js";
import type { InboundMessage, RuntimeState } from "../types.js";
import { AgentRuntime } from "../runtime/agentRuntime.js";
import { WechatStore } from "../store/wechatStore.js";

class MemoryStore extends WechatStore {
  private account: {
    botToken: string;
    botId: string;
    userId: string;
    baseUrl: string;
    savedAt: number;
  } | null = null;

  private state: RuntimeState = {
    updatesBuf: "",
    contextTokens: {},
    lastMessageId: 0,
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
  override loadAccount() { return this.account; }
  override saveAccount(account: NonNullable<MemoryStore["account"]>): void { this.account = account; }
  override clearAccount(): void { this.account = null; }
  override loadState(): RuntimeState {
    return {
      ...this.state,
      contextTokens: { ...this.state.contextTokens },
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
      contextTokens: {},
      lastMessageId: 0,
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
    getAccount: () => store.loadAccount(),
    getState: () => store.loadState(),
    saveState: (state: RuntimeState) => store.saveState(state),
    startQrLogin: vi.fn(),
    checkQrStatus: vi.fn(),
    clearLogin: vi.fn(() => store.resetState()),
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

function message(input: Partial<InboundMessage> = {}): InboundMessage {
  return {
    messageId: 1,
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
    expect(wechatClient.sendText).toHaveBeenCalledWith("user-a", expect.stringContaining("已切换到新会话"));
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

    expect(wechatClient.sendText).toHaveBeenCalledWith("user-a", expect.stringContaining("1."));
    expect(wechatClient.sendText).toHaveBeenCalledWith("user-a", expect.stringContaining("2."));
    expect(wechatClient.sendText).toHaveBeenCalledWith("user-a", expect.stringContaining("cwd: /repo/alpha"));
    expect(wechatClient.sendText).toHaveBeenCalledWith("user-a", expect.stringContaining("cwd: unknown (external thread)"));
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
    expect(wechatClient.sendText).toHaveBeenCalledWith("user-a", expect.stringContaining("thread-2"));
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
    expect(wechatClient.sendText).toHaveBeenCalledWith("user-a", expect.stringContaining("thread-beta-5678"));
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
    expect(wechatClient.sendText).toHaveBeenCalledWith("user-a", expect.stringContaining("external-thread-abc123"));
    expect((runtime.getSnapshot().codex as { threadCwd?: string | null }).threadCwd).toBe("unknown (external thread)");
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

    expect(wechatClient.sendText).toHaveBeenCalledWith("user-b", "该消息类型不支持");
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

    expect(wechatClient.sendText).toHaveBeenCalledWith("user-c", "已经收到你的图片了，请问你要我做什么？");
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
    expect(wechatClient.sendText).toHaveBeenCalledWith("user-e", "当前这个项目根目录下主要有这些目录：\n- dist\n- happy\n- src");
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

    expect(wechatClient.sendText).toHaveBeenCalledWith("user-f", "分析完成。");
    expect(wechatClient.sendLocalFile).toHaveBeenCalledWith("user-f", "/tmp/report.txt");
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

    expect(wechatClient.sendTypingIndicator).toHaveBeenCalledWith("user-g", "typing", "ctx-current-turn");
    expect(wechatClient.sendText).toHaveBeenCalledWith("user-g", "当前这条消息的回复", "ctx-current-turn");
  });
});
