import { describe, expect, it, vi } from "vitest";

import { CodexBridge } from "../codex/codexBridge.js";

function createBridge(): CodexBridge {
  return new CodexBridge({
    config: {
      codexBin: "codex",
      dataDir: "memory",
      pollTimeoutMs: 10,
      typingIntervalMs: 10_000,
      systemPrompt: "system",
      logLevel: "info",
    },
  });
}

describe("CodexBridge cwd behavior", () => {
  it("does not override the original cwd when resuming an existing thread", async () => {
    const bridge = createBridge();
    const request = vi.fn(async () => ({ thread: { id: "thread-123" }, model: "gpt-5" }));
    (bridge as unknown as { request: typeof request }).request = request;

    await (bridge as unknown as { resumeThread: (threadId: string) => Promise<unknown> }).resumeThread("thread-123");

    expect(request).toHaveBeenCalledWith(
      "thread/resume",
      expect.objectContaining({
        threadId: "thread-123",
        cwd: null,
      }),
    );
  });

  it("does not override the thread cwd when starting a turn on a resumed thread", async () => {
    const bridge = createBridge();
    const request = vi.fn(async () => ({ turn: { id: "turn-1" } }));
    (bridge as unknown as { request: typeof request }).request = request;
    (bridge as unknown as { threadId: string | null }).threadId = "thread-123";

    await (bridge as unknown as { sendTurn: (prompt: string) => Promise<void> }).sendTurn("hello");

    expect(request).toHaveBeenCalledWith(
      "turn/start",
      expect.objectContaining({
        threadId: "thread-123",
        cwd: null,
      }),
    );
  });
});
