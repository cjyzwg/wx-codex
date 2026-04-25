const WX_SEND_MARKER_PREFIX = "[[wx_send:";
const WX_SEND_MARKER_REGEX = /\[\[wx_send:([\s\S]*?)\]\]/g;
export const MAX_WECHAT_REPLY_CHARS = 500;
const MIN_PREFERRED_SPLIT_RATIO = 0.4;

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

function findLastRegexBoundary(text: string, pattern: RegExp): number {
  let lastBoundary = -1;
  for (const match of text.matchAll(pattern)) {
    lastBoundary = (match.index || 0) + match[0].length;
  }
  return lastBoundary;
}

function findPreferredSplitIndex(text: string, maxChars: number): number {
  const searchText = text.slice(0, maxChars);
  const minPreferredIndex = Math.max(1, Math.floor(maxChars * MIN_PREFERRED_SPLIT_RATIO));
  const candidates = [
    searchText.lastIndexOf("\n\n") >= 0 ? searchText.lastIndexOf("\n\n") + 2 : -1,
    searchText.lastIndexOf("\n") >= 0 ? searchText.lastIndexOf("\n") + 1 : -1,
    findLastRegexBoundary(searchText, /[。！？!?][”’」』】）)]*/g),
    findLastRegexBoundary(searchText, /[；;][”’」』】）)]*/g),
    findLastRegexBoundary(searchText, /[，、,:：][”’」』】）)]*/g),
    findLastRegexBoundary(searchText, /\s+/g),
  ];

  const preferred = candidates.find((index) => index >= minPreferredIndex);
  return preferred && preferred > 0 ? preferred : maxChars;
}

export function splitWechatReplyText(text: string, maxChars = MAX_WECHAT_REPLY_CHARS): string[] {
  const normalized = normalizeVisibleText(text);
  if (!normalized) {
    return [];
  }

  const chunks: string[] = [];
  let remaining = normalized;

  while (remaining.length > maxChars) {
    const splitIndex = findPreferredSplitIndex(remaining, maxChars);
    const currentChunk = remaining.slice(0, splitIndex).trimEnd();
    if (!currentChunk) {
      chunks.push(remaining.slice(0, maxChars));
      remaining = remaining.slice(maxChars).trimStart();
      continue;
    }

    chunks.push(currentChunk);
    remaining = remaining.slice(splitIndex).trimStart();
  }

  if (remaining) {
    chunks.push(remaining);
  }

  return chunks;
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
