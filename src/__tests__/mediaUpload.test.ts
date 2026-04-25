import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { sendLocalFileToWechat } from "../wechat/mediaUpload.js";
import * as api from "../wechat/api.js";

vi.mock("../wechat/api.js", async () => ({
  generateId: vi.fn(() => "client-1"),
  getUploadUrl: vi.fn(async () => ({ upload_param: "upload-param" })),
  sendMessage: vi.fn(async () => undefined),
}));

const tempDirs: string[] = [];

describe("sendLocalFileToWechat", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        status: 200,
        headers: new Headers({ "x-encrypted-param": "download-param" }),
        text: async () => "",
      })),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it("encodes file aes_key as base64 of the hex string so WeChat can decrypt downloads", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "wxcodex-media-upload-"));
    tempDirs.push(tempDir);
    const filePath = path.join(tempDir, "report.txt");
    fs.writeFileSync(filePath, "hello report", "utf8");

    await sendLocalFileToWechat({
      baseUrl: "https://example.com",
      token: "token",
      contextToken: "ctx-token",
      toUserId: "user-a",
      filePath,
      cdnBaseUrl: "https://cdn.example.com",
    });

    expect(api.sendMessage).toHaveBeenCalledTimes(1);
    const request = vi.mocked(api.sendMessage).mock.calls[0]?.[0];
    const aesKey = request?.body.msg?.item_list?.[0]?.file_item?.media?.aes_key;
    expect(aesKey).toBeTruthy();

    const decoded = Buffer.from(aesKey || "", "base64").toString("ascii");
    expect(decoded).toMatch(/^[0-9a-f]{32}$/);
  });
});
