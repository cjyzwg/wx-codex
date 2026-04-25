import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../wechat/api.js", async () => {
  const actual = await vi.importActual<typeof import("../wechat/api.js")>("../wechat/api.js");
  return {
    ...actual,
    sendMessage: vi.fn(async () => undefined),
    getConfig: vi.fn(async () => ({ typing_ticket: "ticket-1" })),
    sendTyping: vi.fn(async () => undefined),
  };
});

vi.mock("../wechat/mediaUpload.js", () => ({
  sendLocalFileToWechat: vi.fn(async () => undefined),
}));

import * as api from "../wechat/api.js";
import * as mediaUpload from "../wechat/mediaUpload.js";
import { WechatStore } from "../store/wechatStore.js";
import { WechatClient } from "../wechat/wechatClient.js";

const tempDirs: string[] = [];

function createClient(): WechatClient {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wxcodex-wechat-context-"));
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

describe("WechatClient explicit context token overrides", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("uses the current turn context token for text, typing, and file replies", async () => {
    const client = createClient();
    const store = (client as unknown as { store: WechatStore }).store;
    saveAccount(store);

    const state = store.loadState();
    state.contextTokens["bot-id:user-a"] = "ctx-latest-cached";
    store.saveState(state);

    const filePath = path.join(store.getDataDir(), "report.txt");
    fs.writeFileSync(filePath, "report", "utf8");

    await client.sendText("user-a", "hello", "ctx-current-turn");
    await client.sendTypingIndicator("user-a", "typing", "ctx-current-turn");
    await client.sendLocalFile("user-a", filePath, "ctx-current-turn");

    expect(vi.mocked(api.sendMessage).mock.calls[0]?.[0]?.body.msg?.context_token).toBe("ctx-current-turn");
    expect(vi.mocked(api.getConfig)).toHaveBeenCalledWith({
      baseUrl: "https://example.com",
      token: "token",
      ilinkUserId: "user-a",
      contextToken: "ctx-current-turn",
    });
    expect(vi.mocked(mediaUpload.sendLocalFileToWechat)).toHaveBeenCalledWith({
      baseUrl: "https://example.com",
      token: "token",
      contextToken: "ctx-current-turn",
      toUserId: "user-a",
      filePath,
    });
  });
});
