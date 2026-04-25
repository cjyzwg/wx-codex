import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { WechatStore } from "../store/wechatStore.js";
import { WechatClient } from "../wechat/wechatClient.js";
import * as mediaUpload from "../wechat/mediaUpload.js";

vi.mock("../wechat/mediaUpload.js", () => ({
  sendLocalFileToWechat: vi.fn(async () => undefined),
}));

const tempDirs: string[] = [];

function createClient(): WechatClient {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wxcodex-wechat-client-"));
  tempDirs.push(dir);
  return new WechatClient(new WechatStore(dir));
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("WechatClient voice formatting", () => {
  it("uses WeChat voice transcription text as inbound message text", async () => {
    const client = createClient();

    const formatted = await (client as unknown as {
      formatMessage: (message: Record<string, unknown>) => Promise<{
        text: string;
        directReplyText?: string;
        voice?: {
          transcript?: string;
          durationMs?: number | null;
          sampleRate?: number | null;
        };
      }>;
    }).formatMessage({
      message_id: 1,
      from_user_id: "user-a",
      to_user_id: "bot-id",
      item_list: [
        {
          type: 3,
          voice_item: {
            text: "帮我总结一下",
            playtime: 3200,
            sample_rate: 16000,
          },
        },
      ],
    });

    expect(formatted.text).toBe("帮我总结一下");
    expect(formatted.directReplyText).toBeUndefined();
    expect(formatted.voice).toEqual({
      transcript: "帮我总结一下",
      durationMs: 3200,
      sampleRate: 16000,
    });
  });

  it("returns a helpful direct reply when voice transcription is missing", async () => {
    const client = createClient();

    const formatted = await (client as unknown as {
      formatMessage: (message: Record<string, unknown>) => Promise<{
        text: string;
        directReplyText?: string;
      }>;
    }).formatMessage({
      message_id: 2,
      from_user_id: "user-b",
      to_user_id: "bot-id",
      item_list: [
        {
          type: 3,
          voice_item: {},
        },
      ],
    });

    expect(formatted.text).toBe("");
    expect(formatted.directReplyText).toContain("语音");
    expect(formatted.directReplyText).toContain("转写");
  });

  it("uploads and sends a local file attachment for an existing WeChat conversation", async () => {
    const client = createClient();
    const store = (client as unknown as { store: WechatStore }).store;
    store.saveAccount({
      botToken: "token",
      botId: "bot-id",
      userId: "self-id",
      baseUrl: "https://example.com",
      savedAt: Date.now(),
    });
    const state = store.loadState();
    state.contextTokens["bot-id:user-a"] = "ctx-a";
    store.saveState(state);

    const filePath = path.join(store.getDataDir(), "report.txt");
    fs.writeFileSync(filePath, "report");

    await client.sendLocalFile("user-a", filePath);

    expect(mediaUpload.sendLocalFileToWechat).toHaveBeenCalledWith({
      baseUrl: "https://example.com",
      token: "token",
      contextToken: "ctx-a",
      toUserId: "user-a",
      filePath,
    });
  });
});
