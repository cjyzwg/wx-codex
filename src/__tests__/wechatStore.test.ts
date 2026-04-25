import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { WechatStore } from "../store/wechatStore.js";

const tempDirs: string[] = [];

function createStore(): WechatStore {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wxcodex-store-"));
  tempDirs.push(dir);
  return new WechatStore(dir);
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("WechatStore", () => {
  it("initializes per-user thread session defaults", () => {
    const store = createStore();

    const state = store.loadState() as typeof store.loadState extends () => infer T
      ? T & { threadSessions?: Record<string, unknown>; legacySharedThreadId?: string | null }
      : never;

    expect(state.threadSessions).toEqual({});
    expect(state.legacySharedThreadId ?? null).toBeNull();
  });

  it("persists runtime state with utf8 JSON", () => {
    const store = createStore();
    const state = store.loadState() as typeof store.loadState extends () => infer T
      ? T & {
          threadSessions: Record<
            string,
            {
              activeThreadId: string | null;
              lastUsedAt: number | null;
              threads: Array<{
                threadId: string;
                createdAt: number;
                lastUsedAt: number;
                displayCwd: string | null;
                cwdSource: string;
              }>;
            }
          >;
        }
      : never;
    state.threadSessions = {
      "bot:user-a": {
        activeThreadId: "thread-1",
        lastUsedAt: 123,
        threads: [{ threadId: "thread-1", createdAt: 123, lastUsedAt: 123, displayCwd: "/repo/a", cwdSource: "created_here" }],
      },
    };
    state.agentStatus = "running";
    state.codexStatus = "idle";
    state.lastError = "none";
    store.saveState(state);

    const reread = store.loadState() as typeof state;
    expect(reread.threadSessions["bot:user-a"]?.activeThreadId).toBe("thread-1");
    expect(reread.threadSessions["bot:user-a"]?.threads[0]?.displayCwd).toBe("/repo/a");
    expect(reread.threadSessions["bot:user-a"]?.threads[0]?.cwdSource).toBe("created_here");
    expect(reread.agentStatus).toBe("running");
    expect(reread.codexStatus).toBe("idle");
    expect(reread.lastError).toBe("none");
  });

  it("resetState clears queue-related runtime fields", () => {
    const store = createStore();
    const state = store.loadState() as typeof store.loadState extends () => infer T
      ? T & {
          threadSessions: Record<
            string,
            {
              activeThreadId: string | null;
              lastUsedAt: number | null;
              threads: Array<{
                threadId: string;
                createdAt: number;
                lastUsedAt: number;
                displayCwd: string | null;
                cwdSource: string;
              }>;
            }
          >;
        }
      : never;
    state.threadSessions = {
      "bot:user-b": {
        activeThreadId: "thread-2",
        lastUsedAt: 456,
        threads: [{ threadId: "thread-2", createdAt: 456, lastUsedAt: 456, displayCwd: null, cwdSource: "unknown" }],
      },
    };
    state.contextTokens["bot:user"] = "ctx";
    state.lastMessageId = 123;
    store.saveState(state);

    const reset = store.resetState() as typeof state & { legacySharedThreadId?: string | null };
    expect(reset.threadSessions).toEqual({});
    expect(reset.contextTokens).toEqual({});
    expect(reset.lastMessageId).toBe(0);
    expect(reset.legacySharedThreadId ?? null).toBeNull();
  });

  it("exposes legacy sharedThreadId through the migration field", () => {
    const store = createStore();
    const statePath = path.join(store.getDataDir(), "state.json");
    fs.writeFileSync(
      statePath,
      JSON.stringify({
        updatesBuf: "",
        contextTokens: {},
        lastMessageId: 0,
        sharedThreadId: "thread-legacy",
        agentStatus: "stopped",
        codexStatus: "disconnected",
        lastError: null,
      }),
      "utf8",
    );

    const loaded = store.loadState() as ReturnType<typeof store.loadState> & { legacySharedThreadId?: string | null; threadSessions?: Record<string, unknown> };

    expect(loaded.legacySharedThreadId).toBe("thread-legacy");
    expect(loaded.threadSessions).toEqual({});
  });

  it("normalizes older thread records that do not yet include cwd metadata", () => {
    const store = createStore();
    const statePath = path.join(store.getDataDir(), "state.json");
    fs.writeFileSync(
      statePath,
      JSON.stringify({
        updatesBuf: "",
        contextTokens: {},
        lastMessageId: 0,
        threadSessions: {
          "bot:user-a": {
            activeThreadId: "thread-1",
            lastUsedAt: 123,
            threads: [{ threadId: "thread-1", createdAt: 123, lastUsedAt: 123 }],
          },
        },
        agentStatus: "stopped",
        codexStatus: "disconnected",
        lastError: null,
      }),
      "utf8",
    );

    const loaded = store.loadState();

    expect(loaded.threadSessions["bot:user-a"]?.threads[0]?.displayCwd).toBeNull();
    expect(loaded.threadSessions["bot:user-a"]?.threads[0]?.cwdSource).toBe("unknown");
  });
});
