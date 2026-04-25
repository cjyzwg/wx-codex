# WeChat Thread, QR, and Voice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add per-user Codex thread management with explicit switch commands, make the TUI QR code easier to scan, and support WeChat voice input through built-in transcription.

**Architecture:** Keep the current single-process runtime, but replace the one global persisted thread with a per-user conversation map in runtime state. Route thread control commands inside `AgentRuntime`, use WeChat transcription text for voice messages, and keep QR reliability changes limited to the TUI and QR generation path.

**Tech Stack:** TypeScript, Node.js, Ink, Vitest, `qrcode`

---

## File Structure

- Modify: `src/types.ts`
  Add per-user thread state types, voice metadata, and any runtime fields needed by the TUI.
- Modify: `src/store/wechatStore.ts`
  Migrate persisted runtime state from one global thread to per-user thread state with backward-compatible reads.
- Modify: `src/runtime/agentRuntime.ts`
  Intercept thread commands, resolve per-user active threads, update prompt formatting for voice transcription, and keep QR snapshot behavior stable.
- Modify: `src/codex/codexBridge.ts`
  Expose thread selection helpers that can resume an existing thread or create a new one on demand without assuming one shared thread.
- Modify: `src/wechat/wechatClient.ts`
  Read `voice_item.text`, stop classifying supported voice messages as unsupported, and generate a larger terminal QR code.
- Modify: `src/tui/App.tsx`
  Render QR in a dedicated block, avoid wrapping damage, and show a width warning when the terminal is too narrow.
- Modify: `src/__tests__/wechatStore.test.ts`
  Cover persistence and migration behavior for per-user thread state.
- Modify: `src/__tests__/agentRuntime.test.ts`
  Cover thread commands, per-user thread reuse, resume fallback, and voice transcription handling.
- Create: `src/__tests__/qrRendering.test.ts`
  Cover pure layout logic used by the TUI QR block.

### Task 1: Persist Per-User Thread State

**Files:**
- Modify: `src/types.ts:22-30`
- Modify: `src/store/wechatStore.ts:58-110`
- Test: `src/__tests__/wechatStore.test.ts`

- [ ] **Step 1: Write the failing store tests**

```ts
it("persists active thread state per bot:user key", () => {
  const state = store.loadState();
  state.threadSessions = {
    "bot:user-a": {
      activeThreadId: "thread-a2",
      lastUsedAt: 2,
      threads: [
        { threadId: "thread-a1", createdAt: 1, lastUsedAt: 1 },
        { threadId: "thread-a2", createdAt: 2, lastUsedAt: 2 },
      ],
    },
  };
  store.saveState(state);
  expect(store.loadState().threadSessions["bot:user-a"].activeThreadId).toBe("thread-a2");
});

it("migrates legacy sharedThreadId into per-user state defaults", () => {
  // seed raw state.json with sharedThreadId and no threadSessions
  expect(store.loadState().legacySharedThreadId).toBe("thread-legacy");
});
```

- [ ] **Step 2: Run the store tests to verify they fail**

Run: `npm test -- src/__tests__/wechatStore.test.ts`
Expected: FAIL because `RuntimeState` has no `threadSessions` or migration field yet.

- [ ] **Step 3: Implement the new runtime state shape**

```ts
export interface ThreadRecord {
  threadId: string;
  createdAt: number;
  lastUsedAt: number;
}

export interface UserThreadSession {
  activeThreadId: string | null;
  lastUsedAt: number | null;
  threads: ThreadRecord[];
}

export interface RuntimeState {
  updatesBuf: string;
  contextTokens: Record<string, string>;
  lastMessageId: number;
  threadSessions: Record<string, UserThreadSession>;
  legacySharedThreadId?: string | null;
  agentStatus: AgentStatus;
  codexStatus: CodexStatus;
  lastError: string | null;
}
```

- [ ] **Step 4: Update `WechatStore` load/reset logic**

```ts
loadState(): RuntimeState {
  const raw = this.readJson<Partial<RuntimeState> & { sharedThreadId?: string | null }>(this.statePath());
  return {
    updatesBuf: raw?.updatesBuf || "",
    contextTokens: raw?.contextTokens || {},
    lastMessageId: raw?.lastMessageId || 0,
    threadSessions: raw?.threadSessions || {},
    legacySharedThreadId: raw?.sharedThreadId ?? raw?.legacySharedThreadId ?? null,
    agentStatus: raw?.agentStatus || "stopped",
    codexStatus: raw?.codexStatus || "disconnected",
    lastError: raw?.lastError || null,
  };
}
```

- [ ] **Step 5: Run the store tests to verify they pass**

Run: `npm test -- src/__tests__/wechatStore.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/types.ts src/store/wechatStore.ts src/__tests__/wechatStore.test.ts
git commit -m "refactor: persist codex threads per wechat user"
```

### Task 2: Add Runtime Thread Commands and Per-User Thread Resolution

**Files:**
- Modify: `src/runtime/agentRuntime.ts:120-729`
- Modify: `src/codex/codexBridge.ts:183-320`
- Modify: `src/__tests__/agentRuntime.test.ts`

- [ ] **Step 1: Write the failing runtime tests for command handling**

```ts
it("creates a new active thread when the sender sends /new", async () => {
  await handleSingleMessage({ fromUserId: "user-a", text: "/new", ...baseMessage });
  expect(codexBridge.createThread).toHaveBeenCalledTimes(1);
  expect(wechatClient.sendText).toHaveBeenCalledWith("user-a", expect.stringContaining("已切换到新会话"));
});

it("lists threads for the sender when /threads is received", async () => {
  store.saveState(withTwoThreads("bot-id:user-a"));
  await handleSingleMessage({ fromUserId: "user-a", text: "/threads", ...baseMessage });
  expect(wechatClient.sendText).toHaveBeenCalledWith("user-a", expect.stringContaining("1."));
});

it("switches the sender to the selected thread when /use 2 is received", async () => {
  await handleSingleMessage({ fromUserId: "user-a", text: "/use 2", ...baseMessage });
  expect(store.loadState().threadSessions["bot-id:user-a"].activeThreadId).toBe("thread-2");
});
```

- [ ] **Step 2: Run the targeted runtime tests to verify they fail**

Run: `npm test -- src/__tests__/agentRuntime.test.ts`
Expected: FAIL because no command parsing or per-user thread state exists.

- [ ] **Step 3: Add Codex thread-selection helpers**

```ts
async ensureThread(threadId: string | null): Promise<string> {
  await this.connect();
  if (threadId) {
    try {
      return (await this.resumeThread(threadId)).threadId;
    } catch {
      this.onEvent?.(`Failed to resume thread ${threadId}, starting a new thread.`);
    }
  }
  return (await this.startThread()).threadId;
}
```

- [ ] **Step 4: Add per-user session lookup and command interception in `AgentRuntime`**

```ts
const command = this.parseThreadCommand(message.text);
if (command) {
  await this.handleThreadCommand(message, command);
  return;
}

const threadId = await this.ensureMessageThread(message);
this.snapshot.codex.threadId = threadId;
const result = await this.codexBridge.runTurn(prompt, options);
```

- [ ] **Step 5: Stop pre-creating one global thread on agent start**

Run the minimal implementation change so `start()` and `reconnectCodex()` only establish Codex connectivity/status, leaving actual thread creation to first use per sender.

- [ ] **Step 6: Run the targeted runtime tests to verify they pass**

Run: `npm test -- src/__tests__/agentRuntime.test.ts`
Expected: PASS for `/new`, `/threads`, `/use`, and resume-fallback coverage.

- [ ] **Step 7: Commit**

```bash
git add src/runtime/agentRuntime.ts src/codex/codexBridge.ts src/__tests__/agentRuntime.test.ts
git commit -m "feat: add per-user codex thread controls"
```

### Task 3: Support Voice Transcription Input

**Files:**
- Modify: `src/types.ts:196-214`
- Modify: `src/wechat/wechatClient.ts:239-329`
- Modify: `src/runtime/agentRuntime.ts:367-619`
- Test: `src/__tests__/agentRuntime.test.ts`

- [ ] **Step 1: Write the failing voice tests**

```ts
it("forwards voice transcription text to codex", async () => {
  await handleSingleMessage({
    fromUserId: "user-v",
    text: "帮我总结一下",
    voice: { transcript: "帮我总结一下", durationMs: 3000 },
    ...baseMessage,
  });
  expect(codexBridge.runTurn).toHaveBeenCalledWith(expect.stringContaining("语音转写"), expect.anything());
});

it("replies with a fallback when voice transcription is missing", async () => {
  const inbound = formatVoiceWithoutTranscript();
  await handleSingleMessage(inbound);
  expect(wechatClient.sendText).toHaveBeenCalledWith("user-v", expect.stringContaining("语音转文字"));
});
```

- [ ] **Step 2: Run the runtime tests to verify they fail**

Run: `npm test -- src/__tests__/agentRuntime.test.ts`
Expected: FAIL because voice is still marked unsupported.

- [ ] **Step 3: Update `InboundMessage` and voice formatting in `WechatClient`**

```ts
if (item.type === 3) {
  const transcript = item.voice_item?.text?.trim() || "";
  if (transcript) {
    textParts.push(transcript);
    voice = {
      transcript,
      durationMs: item.voice_item?.playtime ?? null,
      sampleRate: item.voice_item?.sample_rate ?? null,
    };
  } else {
    directReplyText = "这条语音暂时没有拿到可用的转写文本，请再发一次文字试试。";
  }
}
```

- [ ] **Step 4: Update prompt formatting to label voice-originated text**

```ts
if (message.voice?.transcript) {
  return `来自用户 ${message.fromUserId} 的语音转写：${message.voice.transcript}`;
}
```

- [ ] **Step 5: Run the runtime tests to verify they pass**

Run: `npm test -- src/__tests__/agentRuntime.test.ts`
Expected: PASS for voice transcription and fallback coverage.

- [ ] **Step 6: Commit**

```bash
git add src/types.ts src/wechat/wechatClient.ts src/runtime/agentRuntime.ts src/__tests__/agentRuntime.test.ts
git commit -m "feat: support wechat voice transcription input"
```

### Task 4: Improve TUI QR Rendering Reliability

**Files:**
- Modify: `src/wechat/wechatClient.ts:231-237`
- Modify: `src/tui/App.tsx:41-160`
- Create: `src/__tests__/qrRendering.test.ts`

- [ ] **Step 1: Extract or define testable QR layout rules**

```ts
function canRenderQr(width: number, qrText: string): boolean {
  const longestLine = qrText.split("\n").reduce((max, line) => Math.max(max, line.length), 0);
  return longestLine > 0 && longestLine + 4 <= width;
}
```

- [ ] **Step 2: Write the failing QR layout tests**

```ts
it("reports false when the terminal is narrower than the qr block", () => {
  expect(canRenderQr(20, mockQr)).toBe(false);
});

it("reports true when the terminal is wide enough for the qr block", () => {
  expect(canRenderQr(120, mockQr)).toBe(true);
});
```

- [ ] **Step 3: Run the targeted QR tests to verify they fail**

Run: `npm test -- src/__tests__/qrRendering.test.ts`
Expected: FAIL because the helper and layout rules do not exist yet.

- [ ] **Step 4: Make the QR generation and TUI rendering changes**

```ts
const qrText = await QRCode.toString(url, { type: "terminal" });

{showingQr && (
  <Box ...>
    <Text bold>WeChat Login</Text>
    {canRenderQr(width, snapshot.wechat.qrText || "") ? (
      snapshot.wechat.qrText.split("\n").map(...)
    ) : (
      <Text color="yellow">Terminal too narrow for a scannable QR code. Enlarge the window and press L or R.</Text>
    )}
  </Box>
)}
```

- [ ] **Step 5: Run the QR tests and full suite**

Run: `npm test`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/wechat/wechatClient.ts src/tui/App.tsx src/__tests__/qrRendering.test.ts
git commit -m "fix: improve tui wechat qr rendering"
```

## Final Verification

- [ ] Run: `npm test`
Expected: all tests pass

- [ ] Run: `npm run build`
Expected: TypeScript build succeeds with no new errors

- [ ] Run: `git status --short`
Expected: clean working tree except for any plan/spec docs intentionally left uncommitted
