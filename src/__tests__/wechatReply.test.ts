import { describe, expect, it } from "vitest";

import { processWechatReplyChunk } from "../runtime/wechatReply.js";

describe("wechat reply marker parsing", () => {
  it("extracts wx_send markers and removes them from visible text", () => {
    const result = processWechatReplyChunk("已生成结果。\n[[wx_send:/tmp/result.txt]]", "", true);

    expect(result.visibleText).toBe("已生成结果。");
    expect(result.filePaths).toEqual(["/tmp/result.txt"]);
    expect(result.carryover).toBe("");
  });

  it("holds an incomplete marker until the following chunk arrives", () => {
    const first = processWechatReplyChunk("已生成结果。\n[[wx_send:/tmp/res", "", false);
    expect(first.visibleText).toBe("已生成结果。");
    expect(first.filePaths).toEqual([]);
    expect(first.carryover).toBe("[[wx_send:/tmp/res");

    const second = processWechatReplyChunk("ult.txt]]", first.carryover, true);
    expect(second.visibleText).toBe("");
    expect(second.filePaths).toEqual(["/tmp/result.txt"]);
    expect(second.carryover).toBe("");
  });

  it("extracts multiple markers from one reply", () => {
    const result = processWechatReplyChunk(
      "附件如下：\n[[wx_send:/tmp/a.txt]]\n[[wx_send:/tmp/b.png]]",
      "",
      true,
    );

    expect(result.visibleText).toBe("附件如下：");
    expect(result.filePaths).toEqual(["/tmp/a.txt", "/tmp/b.png"]);
  });
});
