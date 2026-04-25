# WeChat Thread Switching, TUI QR, and Voice Input Design

## Goal

Fix three runtime problems in WXCodex:

1. Codex thread state is currently pinned to a single persisted thread and cannot be intentionally rotated or switched per WeChat user.
2. The terminal QR code shown during WeChat login is difficult to scan reliably.
3. Voice messages are treated as unsupported even though the WeChat payload may already contain speech-to-text transcription.

## Current Context

- `src/runtime/agentRuntime.ts` orchestrates WeChat polling, Codex turns, login state, and TUI updates.
- `src/store/wechatStore.ts` persists a single `RuntimeState` object that currently contains one global `sharedThreadId`.
- `src/wechat/wechatClient.ts` formats inbound WeChat messages, generates QR artifacts, and sends text/typing responses.
- `src/tui/App.tsx` renders the dashboard and login QR block.

## Design Summary

### 1. Thread Management

Replace the single global `sharedThreadId` model with per-user thread state keyed by `botId:userId`.

Each user conversation state will store:

- `activeThreadId`: the thread currently used for new turns
- `threads`: an ordered list of known thread records
- `lastUsedAt`: timestamp for the active thread or conversation entry

Each thread record will store:

- `threadId`
- `createdAt`
- `lastUsedAt`

Behavior:

- Default behavior remains "reuse the active thread for this WeChat user".
- If the user has no active thread, create one on demand and persist it.
- Add lightweight chat commands handled before Codex:
  - `/new` creates a new Codex thread for the sender and makes it active
  - `/threads` lists known threads for the sender with a stable numeric index
  - `/use <index-or-prefix>` switches the active thread for the sender
- Agent start/reconnect no longer assumes a single global thread must be resumed ahead of time. Thread selection becomes per-message/per-user.

This keeps the current "shared conversation" feel for each WeChat sender while making thread creation and switching explicit.

### 2. TUI QR Reliability

Keep the existing `qrcode.png` artifact, but improve the in-terminal QR rendering path.

Behavior:

- Generate the terminal QR code without `small: true` so the rendered code uses larger blocks.
- Keep the QR text stable while polling status so the TUI does not constantly redraw the code itself.
- Render the QR inside a dedicated TUI panel with minimal adjacent text to reduce wrapping and layout interference.
- If terminal width is too narrow for a safe render, show a warning instead of a broken QR code.

This preserves the current CLI/TUI-only login flow while making the displayed code more likely to scan.

### 3. Voice Message Handling

Treat voice messages as supported input when WeChat provides speech-to-text transcription.

Behavior:

- For `voice_item`, read `voice_item.text` first.
- If transcription text exists, use it as the message text sent to Codex.
- Preserve voice metadata in the formatted prompt so Codex can tell the text originated from voice.
- If transcription is missing, send a clear fallback reply instead of the current generic unsupported-type path.
- The first implementation returns standard text replies through existing `sendText()` behavior.

This matches the practical behavior used by the referenced projects: accept voice input via WeChat transcription and answer normally in chat.

## Runtime Flow Changes

### Thread Selection

Before a Codex turn starts:

1. Resolve the sender conversation key from `botId:userId`
2. Parse and intercept thread control commands if present
3. Ensure there is an active thread for that sender
4. Resume or create the selected thread inside `CodexBridge`
5. Run the turn against that thread
6. Persist `lastUsedAt` for the conversation and thread

### Voice Prompt Formatting

When a message originated from voice transcription, the prompt should reflect that origin, for example:

`来自用户 <id> 的语音转写：<text>`

This keeps the message understandable to Codex without introducing extra dependencies.

## Data Model Changes

`RuntimeState` will be expanded from:

- one global `sharedThreadId`

to:

- a per-user thread map
- optional legacy `sharedThreadId` retention only for migration compatibility during load

On read:

- if legacy `sharedThreadId` exists and no per-user thread state exists yet, keep it available for migration logic

On write:

- persist only the new per-user thread structure

## Error Handling

- Invalid `/use` targets return a friendly help message to the sender.
- Failed thread resume falls back to creating a new thread for that sender and records an event.
- Missing voice transcription returns a clear reply indicating the voice could not be parsed into text.
- QR width failures do not try to render a malformed QR block.

## Testing Strategy

Update and extend tests around:

- store persistence for per-user thread state
- runtime behavior for `/new`, `/threads`, and `/use`
- fallback behavior when resuming a stored thread fails
- voice message handling with transcription text
- voice message fallback when transcription is absent
- TUI QR behavior where practical through snapshot-free logic checks

## Out of Scope

- Native TTS voice replies back to WeChat
- Browser-based login preview pages
- Large UI refactors beyond the login QR block and status text
