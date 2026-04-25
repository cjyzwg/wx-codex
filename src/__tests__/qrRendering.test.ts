import { describe, expect, it } from "vitest";

import { canRenderQrBlock } from "../tui/qrLayout.js";

const MOCK_QR = [
  "████████████████████████",
  "██              ████████",
  "██  ██████████  ██    ██",
  "██  ██      ██  ██    ██",
  "████████████████████████",
].join("\n");

describe("QR layout helpers", () => {
  it("returns false when the terminal is narrower than the qr block", () => {
    expect(canRenderQrBlock(20, MOCK_QR)).toBe(false);
  });

  it("returns true when the terminal is wide enough for the qr block", () => {
    expect(canRenderQrBlock(80, MOCK_QR)).toBe(true);
  });

  it("ignores ansi escape sequences when measuring terminal qr width", () => {
    const ansiQr = "\u001B[47m  \u001B[0m\u001B[40m  \u001B[0m";

    expect(canRenderQrBlock(8, ansiQr)).toBe(true);
  });
});
