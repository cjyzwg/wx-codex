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

function setThreadSession(store: MemoryStore, userId: string, threads: Array<{ threadId: string; createdAt: number; lastUsedAt: number }>, activeThreadId: string): void {
  const state = store.loadState();
  state.threadSessions[`bot-id:${userId}`] = {
    activeThreadId,
    lastUsedAt: threads[threads.length - 1]?.lastUsedAt ?? null,
    threads,
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
      threads: [{ threadId: "thread-stale", createdAt: 123, lastUsedAt: 123 }],
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

  it("auto starts when login state exists and sends a ready message", async () => {
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
    expect(wechatClient.sendText).toHaveBeenCalledWith("self-id", "连接微信成功，你现在可以通过聊天窗口与我对话了");
    expect(runtime.getSnapshot().agent.status).toBe("running");
    await runtime.stop();
  });

  it("prefers an existing context-token user when sending the startup ready message", async () => {
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

    expect(wechatClient.sendText).toHaveBeenCalledWith("user-y", "连接微信成功，你现在可以通过聊天窗口与我对话了");
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
    expect(wechatClient.sendText).toHaveBeenCalledWith("user-a", expect.stringContaining("已切换到新会话"));
    expect(codexBridge.runTurn).not.toHaveBeenCalled();
  });

  it("lists known threads when the sender sends /threads", async () => {
    const store = new MemoryStore();
    saveAccount(store);
    setThreadSession(
      store,
      "user-a",
      [
        { threadId: "thread-1", createdAt: 1, lastUsedAt: 1 },
        { threadId: "thread-2", createdAt: 2, lastUsedAt: 2 },
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
    expect(wechatClient.sendText).toHaveBeenCalledWith("user-a", expect.stringContaining("external-thread-abc123"));
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

  it("streams codex agent text to WeChat instead of only sending the final line", async () => {
    const store = new MemoryStore();
    saveAccount(store);

    const wechatClient = createWechatClient(store);
    const codexBridge = createCodexBridge({
      runTurn: vi.fn(async (_prompt: string, options?: { onText?: (text: string) => Promise<void> | void }) => {
        await options?.onText?.("第一句");
        await options?.onText?.("第二句");
        return { replyText: "第二句", streamedAny: true, finalAlreadyStreamed: true };
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

    expect(wechatClient.sendText).toHaveBeenCalledTimes(2);
    expect(wechatClient.sendText).toHaveBeenNthCalledWith(1, "user-d", "第一句");
    expect(wechatClient.sendText).toHaveBeenNthCalledWith(2, "user-d", "第二句");
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
});
