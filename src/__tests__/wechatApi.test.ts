import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { sendMessage } from "../wechat/api.js";

describe("WeChat API sendMessage", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("throws when WeChat returns a business-level sendmessage error inside a 200 response", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ ret: -1, errmsg: "rate limited" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await expect(
      sendMessage({
        baseUrl: "https://example.com",
        token: "token",
        body: {
          msg: {
            to_user_id: "user-a",
            item_list: [{ type: 1, text_item: { text: "hello" } }],
          },
        },
      }),
    ).rejects.toThrow("sendMessage business error: rate limited");
  });
});
