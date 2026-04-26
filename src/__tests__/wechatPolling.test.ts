import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../wechat/api.js", async () => {
  const actual = await vi.importActual<typeof import("../wechat/api.js")>("../wechat/api.js");
  return {
    ...actual,
    getUpdates: vi.fn(),
  };
});

import * as api from "../wechat/api.js";
import { WechatStore } from "../store/wechatStore.js";
import { WechatClient } from "../wechat/wechatClient.js";

const tempDirs: string[] = [];

function createClient(): WechatClient {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wxcodex-wechat-polling-"));
  tempDirs.push(dir);
  return new WechatClient(new WechatStore(dir));
}

function saveAccount(store: WechatStore): void {
  store.saveAccount({
    botToken: "token",
    botId: "bot-id",
    userId: "self-id",
    baseUrl: "https://example.com",
    savedAt: Date.now(),
  });
}

function saveSecondAccount(store: WechatStore): void {
  store.saveAccount({
    botToken: "token-b",
    botId: "bot-b",
    userId: "self-b",
    baseUrl: "https://example-b.com",
    savedAt: Date.now() + 1,
  });
}

function rawMessage(id: number) {
  return {
    message_type: 1,
    message_id: id,
    from_user_id: "user-a",
    to_user_id: "bot-id",
    context_token: `ctx-${id}`,
    item_list: [{ type: 1, text_item: { text: `msg-${id}` } }],
  };
}

describe("WechatClient polling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not drop older paged updates after receiving an initial batch of 10 messages", async () => {
    const client = createClient();
    const store = (client as unknown as { store: WechatStore }).store;
    saveAccount(store);

    vi.mocked(api.getUpdates)
      .mockResolvedValueOnce({
        ret: 0,
        get_updates_buf: "buf-2",
        msgs: Array.from({ length: 10 }, (_value, index) => rawMessage(110 - index)),
      })
      .mockResolvedValueOnce({
        ret: 0,
        get_updates_buf: "buf-3",
        msgs: Array.from({ length: 5 }, (_value, index) => rawMessage(100 - index)),
      });

    const first = await client.pollMessages({ timeoutMs: 1 });
    const second = await client.pollMessages({ timeoutMs: 1 });

    expect(first.map((message) => message.messageId)).toEqual([110, 109, 108, 107, 106, 105, 104, 103, 102, 101]);
    expect(second.map((message) => message.messageId)).toEqual([100, 99, 98, 97, 96]);
  });

  it("polls different bots with isolated update buffers and tags inbound messages by bot", async () => {
    const client = createClient();
    const store = (client as unknown as { store: WechatStore }).store;
    saveAccount(store);
    saveSecondAccount(store);

    vi.mocked(api.getUpdates)
      .mockResolvedValueOnce({
        ret: 0,
        get_updates_buf: "buf-a-1",
        msgs: [rawMessage(201)],
      })
      .mockResolvedValueOnce({
        ret: 0,
        get_updates_buf: "buf-b-1",
        msgs: [rawMessage(301)],
      });

    const first = await client.pollMessages({ timeoutMs: 1, botId: "bot-id" });
    const second = await client.pollMessages({ timeoutMs: 1, botId: "bot-b" });
    const state = store.loadState();

    expect(first[0]?.botId).toBe("bot-id");
    expect(second[0]?.botId).toBe("bot-b");
    expect(vi.mocked(api.getUpdates).mock.calls[0]?.[0]).toMatchObject({
      baseUrl: "https://example.com",
      token: "token",
      updatesBuf: "",
    });
    expect(vi.mocked(api.getUpdates).mock.calls[1]?.[0]).toMatchObject({
      baseUrl: "https://example-b.com",
      token: "token-b",
      updatesBuf: "",
    });
    expect(state.contextTokens["bot-id:user-a"]).toBe("ctx-201");
    expect(state.contextTokens["bot-b:user-a"]).toBe("ctx-301");
  });
});
