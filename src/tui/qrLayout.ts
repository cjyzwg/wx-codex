export function splitQrLines(qrText: string): string[] {
  return qrText
    .split("\n")
    .filter((line, index, lines) => !(index === lines.length - 1 && line.length === 0));
}

export function canRenderQrBlock(width: number, qrText: string): boolean {
  const longestLine = splitQrLines(qrText).reduce((max, line) => Math.max(max, line.length), 0);
  return longestLine > 0 && longestLine + 4 <= width;
}
