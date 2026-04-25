const WX_SEND_MARKER_PREFIX = "[[wx_send:";
const WX_SEND_MARKER_REGEX = /\[\[wx_send:([\s\S]*?)\]\]/g;

export interface ProcessWechatReplyChunkResult {
  visibleText: string;
  filePaths: string[];
  carryover: string;
}

function findIncompleteMarkerStart(text: string): number {
  const markerStart = text.lastIndexOf(WX_SEND_MARKER_PREFIX);
  if (markerStart < 0) {
    return -1;
  }

  const markerEnd = text.indexOf("]]", markerStart + WX_SEND_MARKER_PREFIX.length);
  return markerEnd >= 0 ? -1 : markerStart;
}

function normalizeVisibleText(text: string): string {
  return text
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function processWechatReplyChunk(
  chunk: string,
  carryover: string,
  isFinal: boolean,
): ProcessWechatReplyChunkResult {
  const combined = `${carryover}${chunk}`;
  let safeText = combined;
  let nextCarryover = "";

  if (!isFinal) {
    const incompleteStart = findIncompleteMarkerStart(combined);
    if (incompleteStart >= 0) {
      safeText = combined.slice(0, incompleteStart);
      nextCarryover = combined.slice(incompleteStart);
    }
  }

  const filePaths: string[] = [];
  const visibleText = normalizeVisibleText(
    safeText.replace(WX_SEND_MARKER_REGEX, (_match, pathValue: string) => {
      const trimmedPath = pathValue.trim();
      if (trimmedPath) {
        filePaths.push(trimmedPath);
      }
      return "";
    }),
  );

  return {
    visibleText,
    filePaths,
    carryover: nextCarryover,
  };
}
