import { randomUUID } from "node:crypto";

import type { AppConfig } from "../config.js";
import type {
  AgentStatus,
  CodexCardState,
  CodexStatus,
  CodexThreadRecord,
  InboundMedia,
  InboundMessage,
  RuntimeEvent,
  RuntimeSnapshot,
  RuntimeState,
  ThreadCwdSource,
  UserThreadSession,
  WechatCardState,
} from "../types.js";
import { WechatStore } from "../store/wechatStore.js";
import { CodexBridge } from "../codex/codexBridge.js";
import { WechatClient } from "../wechat/wechatClient.js";
import { processWechatReplyChunk, splitWechatReplyText } from "./wechatReply.js";

type Listener = (snapshot: RuntimeSnapshot) => void;
type PendingMediaContext = {
  messages: InboundMessage[];
  createdAt: number;
};

export interface RuntimeDeps {
  store?: WechatStore;
  wechatClient?: WechatClient;
  codexBridge?: CodexBridge;
}

type StartOptions = {
};

type ThreadCommand =
  | { type: "new" }
  | { type: "list" }
  | { type: "use"; target: string; displayCwd?: string | null }
  | { type: "botname"; label: string | null; mode: "set" | "show" | "clear" };

type ThreadSelectionResult =
  | { status: "selected"; threadId: string }
  | { status: "ambiguous"; matches: string[] }
  | { status: "missing" };

type TypingTarget = {
  botId: string;
  userId: string;
  contextToken: string | null;
};

export class AgentRuntime {
  private readonly listeners = new Set<Listener>();
  private readonly store: WechatStore;
  private readonly wechatClient: WechatClient;
  private readonly codexBridge: CodexBridge;
  private readonly config: AppConfig;

  private snapshot: RuntimeSnapshot;
  private queue: InboundMessage[] = [];
  private processing = false;
  private pollAbortController: AbortController | null = null;
  private running = false;
  private qrPollInterval: NodeJS.Timeout | null = null;
  private typingInterval: NodeJS.Timeout | null = null;
  private currentTypingTarget: TypingTarget | null = null;
  private readonly pendingMediaByUser = new Map<string, PendingMediaContext>();

  constructor(config: AppConfig, deps: RuntimeDeps = {}) {
    this.config = config;
    this.store = deps.store || new WechatStore(config.dataDir);
    this.wechatClient = deps.wechatClient || new WechatClient(this.store);
    this.codexBridge =
      deps.codexBridge ||
      new CodexBridge({
        config,
        onStatusChange: (status, error) => {
          this.snapshot.codex.status = status;
          this.snapshot.codex.lastError = error || null;
          this.persistRuntimeState(status, this.snapshot.agent.status, error || null);
          this.publish();
        },
        onEvent: (message) => {
          this.pushEvent("info", message);
        },
      });

    this.snapshot = {
      wechat: this.buildWechatState(),
      codex: this.buildCodexState(),
      agent: {
        status: this.store.loadState().agentStatus,
        queueLength: 0,
        currentUserId: null,
        lastCompletedAt: null,
      },
      events: [],
    };
  }

  async initialize(): Promise<void> {
    this.snapshot.agent.status = "stopped";
    this.snapshot.agent.queueLength = 0;
    this.snapshot.agent.currentUserId = null;

    const availability = CodexBridge.detectAvailability(this.config.codexBin);
    this.snapshot.codex.available = availability.available;
    this.snapshot.codex.version = availability.version;
    this.snapshot.codex.lastError = availability.error;
    if (!availability.available) {
      this.snapshot.codex.status = "error";
      this.persistRuntimeState("error", "stopped", availability.error);
      this.pushEvent("error", availability.error || "Codex CLI is unavailable.");
    } else {
      this.snapshot.codex.status = "disconnected";
      this.snapshot.codex.lastError = null;
      this.persistRuntimeState("disconnected", "stopped", null);
    }

    this.publish();
  }

  getSnapshot(): RuntimeSnapshot {
    return {
      wechat: { ...this.snapshot.wechat },
      codex: { ...this.snapshot.codex },
      agent: { ...this.snapshot.agent },
      events: [...this.snapshot.events],
    };
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.getSnapshot());
    return () => {
      this.listeners.delete(listener);
    };
  }

  async start(options: StartOptions = {}): Promise<void> {
    if (this.running) {
      return;
    }

    const accounts = this.wechatClient.getAccounts();
    if (accounts.length === 0) {
      this.pushEvent("warn", "Please log in to WeChat first.");
      return;
    }

    const availability = CodexBridge.detectAvailability(this.config.codexBin);
    this.snapshot.codex.available = availability.available;
    this.snapshot.codex.version = availability.version;
    this.snapshot.codex.lastError = availability.error;
    if (!availability.available) {
      this.snapshot.codex.status = "error";
      this.snapshot.agent.status = "error";
      this.persistRuntimeState("error", "error", availability.error);
      this.pushEvent("error", availability.error || "Codex CLI is unavailable.");
      this.publish();
      return;
    }

    this.running = true;
    this.snapshot.agent.status = "running";
    this.persistRuntimeState(this.snapshot.codex.status, "running", null);
    this.publish();
    this.pushEvent("info", `Starting agent for ${accounts.length} WeChat bot(s).`);

    try {
      await this.codexBridge.connect();
      const nextState = this.store.loadState();
      nextState.codexStatus = "idle";
      nextState.agentStatus = "running";
      nextState.lastError = null;
      this.store.saveState(nextState);
      this.setSnapshotThread(this.findMostRecentThreadId(nextState), nextState);
      this.snapshot.codex.status = "idle";
      this.snapshot.codex.lastConnectedAt = Date.now();
      this.publish();
      this.startPollingLoop();
    } catch (error) {
      this.running = false;
      this.snapshot.agent.status = "error";
      this.snapshot.codex.status = "error";
      const message = error instanceof Error ? error.message : String(error);
      this.persistRuntimeState("error", "error", message);
      this.pushEvent("error", `Failed to start agent: ${message}`);
      this.publish();
    }
  }

  async stop(): Promise<void> {
    if (!this.running && this.snapshot.agent.status === "stopped") {
      return;
    }

    this.running = false;
    this.queue = [];
    this.pendingMediaByUser.clear();
    this.snapshot.agent.queueLength = 0;
    this.snapshot.agent.currentUserId = null;
    this.snapshot.agent.status = "stopped";
    this.stopQrPolling();
    await this.cancelTyping();

    if (this.pollAbortController) {
      this.pollAbortController.abort();
      this.pollAbortController = null;
    }

    await this.codexBridge.disconnect();
    this.snapshot.codex.status = "disconnected";
    this.setSnapshotThread(null);
    this.persistRuntimeState("disconnected", "stopped", null);
    this.pushEvent("info", "Agent stopped.");
    this.publish();
  }

  async shutdown(): Promise<void> {
    this.stopQrPolling();
    await this.stop();
  }

  async autoStartIfPossible(): Promise<void> {
    if (this.wechatClient.getAccounts().length === 0) {
      return;
    }
    await this.start();
  }

  async beginWechatLogin(forceNew = false): Promise<void> {
    if (forceNew) {
      await this.reloginWechat();
      return;
    }

    try {
      const qr = await this.wechatClient.startQrLogin(false);
      this.snapshot.wechat.loginState = "logging_in";
      this.snapshot.wechat.qrStatus = qr.qrStatus;
      this.snapshot.wechat.qrText = qr.qrText;
      this.snapshot.wechat.qrPath = qr.qrPath;
      this.snapshot.wechat.qrUrl = qr.qrUrl;
      this.pushEvent("info", "WeChat QR code generated.");
      this.publish();
      this.startQrPolling();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.pushEvent("error", `Failed to start WeChat login: ${message}`);
      this.publish();
    }
  }

  async reloginWechat(): Promise<void> {
    await this.stop();
    this.wechatClient.clearLogin();
    await this.codexBridge.resetSharedThread();
    this.snapshot.wechat = this.buildWechatState();
    this.setSnapshotThread(null);
    this.snapshot.codex.status = this.snapshot.codex.available ? "disconnected" : "error";
    this.snapshot.agent.status = "stopped";
    this.pushEvent("warn", "WeChat login was reset. Scan the new QR code to log in again.");
    this.publish();
    await this.beginWechatLogin(false);
  }

  async logoutActiveWechat(): Promise<void> {
    const activeBotId = this.snapshot.wechat.activeBotId || this.wechatClient.getAccount()?.botId || null;
    if (!activeBotId) {
      this.pushEvent("warn", "There is no active WeChat account to remove.");
      this.publish();
      return;
    }

    const wasRunning = this.running;
    await this.stop();
    this.wechatClient.clearLogin(activeBotId);
    this.pruneRuntimeStateForBot(activeBotId);
    this.snapshot.wechat = this.buildWechatState();
    const nextState = this.store.loadState();
    this.setSnapshotThread(this.findMostRecentThreadId(nextState), nextState);
    this.snapshot.codex.status = this.snapshot.codex.available ? "disconnected" : "error";
    this.snapshot.agent.status = "stopped";
    this.pushEvent("warn", `Removed WeChat bot ${activeBotId}.`);
    this.publish();

    if (wasRunning && this.wechatClient.getAccounts().length > 0) {
      await this.start();
    }
  }

  cycleActiveWechatBot(): void {
    const accounts = this.wechatClient.getAccounts();
    if (accounts.length <= 1) {
      return;
    }

    const currentBotId = this.snapshot.wechat.activeBotId || accounts[0]?.botId || null;
    const currentIndex = accounts.findIndex((account) => account.botId === currentBotId);
    const nextAccount = accounts[(currentIndex + 1 + accounts.length) % accounts.length] || accounts[0];
    if (!nextAccount) {
      return;
    }

    this.wechatClient.setActiveBotId(nextAccount.botId);
    this.snapshot.wechat = this.buildWechatState();
    this.pushEvent("info", `Active WeChat bot switched to ${nextAccount.botId}.`);
    this.publish();
  }

  async reconnectCodex(): Promise<void> {
    try {
      const threadId = await this.codexBridge.reconnect(this.snapshot.codex.threadId);
      this.snapshot.codex.status = "idle";
      this.snapshot.codex.lastConnectedAt = Date.now();
      const nextState = this.store.loadState();
      nextState.codexStatus = "idle";
      nextState.lastError = null;
      this.store.saveState(nextState);
      this.setSnapshotThread(threadId, nextState);
      this.pushEvent("info", threadId ? "Codex reconnected and resumed the active thread." : "Codex reconnected.");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.snapshot.codex.status = "error";
      this.snapshot.codex.lastError = message;
      this.persistRuntimeState("error", this.snapshot.agent.status, message);
      this.pushEvent("error", `Failed to reconnect Codex: ${message}`);
    }
    this.publish();
  }

  closeOverlay(): void {
    this.stopQrPolling();
    if (this.snapshot.wechat.loginState === "logging_in" && this.wechatClient.getAccounts().length > 0) {
      this.snapshot.wechat.loginState = "logged_in";
    } else if (this.snapshot.wechat.loginState === "logging_in") {
      this.snapshot.wechat.loginState = "logged_out";
    }
    this.snapshot.wechat.qrText = null;
    this.snapshot.wechat.qrStatus = null;
    this.snapshot.wechat.qrPath = null;
    this.snapshot.wechat.qrUrl = null;
    this.publish();
  }

  private startPollingLoop(): void {
    const run = async () => {
      while (this.running) {
        this.pollAbortController = new AbortController();

        try {
          for (const account of this.wechatClient.getAccounts()) {
            const messages = await this.wechatClient.pollMessages({
              timeoutMs: this.config.pollTimeoutMs,
              signal: this.pollAbortController.signal,
              botId: account.botId,
            });

            this.updateBotLastPollAt(account.botId, Date.now());
            this.publish();
            if (messages.length > 0) {
              for (const message of messages) {
                this.queue.push(message);
                this.pushEvent("info", `Received message from ${message.botId}/${message.fromUserId}: ${this.describeMessageForLog(message)}`);
              }
              this.snapshot.agent.queueLength = this.queue.length;
              this.publish();
              await this.processQueue();
            }
          }
        } catch (error) {
          if (!this.running) {
            break;
          }

          const message = error instanceof Error ? error.message : String(error);
          this.snapshot.agent.status = "error";
          this.snapshot.codex.status = "error";
          this.persistRuntimeState("error", "error", message);
          this.pushEvent("error", `Polling failed: ${message}`);
          this.publish();
          this.running = false;
          break;
        } finally {
          this.pollAbortController = null;
        }
      }
    };

    void run();
  }

  private async processQueue(): Promise<void> {
    if (this.processing) {
      return;
    }
    this.processing = true;

    try {
      while (this.running && this.queue.length > 0) {
        const message = this.queue.shift()!;
        this.snapshot.agent.queueLength = this.queue.length;
        this.snapshot.agent.currentUserId = message.fromUserId;
        this.publish();

        await this.handleSingleMessage(message);

        this.snapshot.agent.currentUserId = null;
        this.snapshot.agent.lastCompletedAt = Date.now();
        this.snapshot.agent.queueLength = this.queue.length;
        this.publish();
      }
    } finally {
      this.processing = false;
    }
  }

  private async handleSingleMessage(message: InboundMessage): Promise<void> {
    const threadCommand = this.parseThreadCommand(message.text);
    if (threadCommand) {
      await this.handleThreadCommand(message, threadCommand);
      return;
    }

    if (message.directReplyText) {
      try {
        await this.sendWechatText(message.botId, message.fromUserId, message.directReplyText, message.contextToken);
        this.pushEvent("warn", `Unsupported message type from ${message.fromUserId}; replied without Codex.`);
      } catch (error) {
        const messageText = error instanceof Error ? error.message : String(error);
        this.snapshot.agent.status = "error";
        this.persistRuntimeState(this.snapshot.codex.status, "error", messageText);
        this.pushEvent("error", `Failed to send unsupported-type reply to ${message.fromUserId}: ${messageText}`);
      } finally {
        if (this.snapshot.agent.status !== "stopped") {
          this.snapshot.agent.status = this.running ? "running" : "stopped";
        }
        this.publish();
      }
      return;
    }

    if (this.shouldDeferForMedia(message)) {
      await this.deferMediaMessage(message);
      return;
    }

    const pendingMedia = this.peekPendingMedia(message.botId, message.fromUserId);
    if (pendingMedia && !message.text.trim()) {
      await this.sendWechatText(message.botId, message.fromUserId, this.buildMediaReceiptText(this.collectDeferredMedia(pendingMedia)), message.contextToken);
      this.pushEvent("warn", `Waiting for a text follow-up from ${message.botId}/${message.fromUserId} after media upload.`);
      return;
    }

    const threadId = await this.ensureMessageThread(message.botId, message.fromUserId);
    const formattedPrompt = this.buildPrompt(message, pendingMedia);
    let replyCarryover = "";
    let streamedReplyText = "";
    const streamedReplyFiles: string[] = [];
    if (pendingMedia) {
      this.clearPendingMedia(message.botId, message.fromUserId);
    }
    this.setSnapshotThread(threadId);
    this.pushEvent("info", `Codex is handling a turn for ${message.fromUserId}.`);

    try {
      await this.sendWechatTypingIndicator(message.botId, message.fromUserId, "typing", message.contextToken);
      this.currentTypingTarget = {
        botId: message.botId,
        userId: message.fromUserId,
        contextToken: message.contextToken || null,
      };
      this.typingInterval = setInterval(() => {
        if (!this.currentTypingTarget) {
          return;
        }
        void this.sendWechatTypingIndicator(
          this.currentTypingTarget.botId,
          this.currentTypingTarget.userId,
          "typing",
          this.currentTypingTarget.contextToken || undefined,
        ).catch(() => {
          // Ignore heartbeat failures. The main turn flow will surface real errors.
        });
      }, this.config.typingIntervalMs);

      const result = await this.codexBridge.runTurn(formattedPrompt, {
        onText: async (text, meta) => {
          const processed = processWechatReplyChunk(text, replyCarryover, meta?.isFinal ?? false);
          replyCarryover = processed.carryover;
          streamedReplyText = this.appendWechatReplyText(streamedReplyText, processed.visibleText);
          streamedReplyFiles.push(...processed.filePaths);
        },
      });

      const replyPayload = result.finalAlreadyStreamed
        ? { visibleText: streamedReplyText, filePaths: streamedReplyFiles }
        : processWechatReplyChunk(result.replyText, "", true);
      await this.deliverWechatReplyChunk(message.botId, message.fromUserId, replyPayload, "Reply sent", message.contextToken);
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error);
      this.snapshot.agent.status = "error";
      this.persistRuntimeState(this.snapshot.codex.status, "error", messageText);
      this.pushEvent("error", `Failed to handle message for ${message.fromUserId}: ${messageText}`);
    } finally {
      await this.cancelTyping();
      if (this.snapshot.agent.status !== "stopped") {
        this.snapshot.agent.status = this.running ? "running" : "stopped";
      }
      this.publish();
    }
  }

  private parseThreadCommand(text: string): ThreadCommand | null {
    const normalized = text.trim();
    if (normalized === "/new") {
      return { type: "new" };
    }
    if (normalized === "/threads") {
      return { type: "list" };
    }
    if (normalized === "/botname") {
      return { type: "botname", label: null, mode: "show" };
    }
    const botnameMatch = normalized.match(/^\/botname\s+(.+)$/);
    if (botnameMatch) {
      const label = botnameMatch[1].trim();
      if (label.toLowerCase() === "clear") {
        return { type: "botname", label: null, mode: "clear" };
      }
      if (label) {
        return { type: "botname", label, mode: "set" };
      }
    }
    const useMatch = normalized.match(/^\/use\s+(.+)$/);
    if (useMatch) {
      const rawArgs = useMatch[1].trim();
      const cwdMatch = rawArgs.match(/^(.*?)\s+--cwd\s+(.+)$/);
      if (cwdMatch) {
        return {
          type: "use",
          target: cwdMatch[1].trim(),
          displayCwd: cwdMatch[2].trim() || null,
        };
      }
      return { type: "use", target: rawArgs };
    }
    return null;
  }

  private async handleThreadCommand(message: InboundMessage, command: ThreadCommand): Promise<void> {
    try {
      if (command.type === "botname") {
        const currentAccount = this.store.loadAccount(message.botId);
        if (command.mode === "show") {
          await this.sendWechatText(
            message.botId,
            message.fromUserId,
            currentAccount?.label ? `当前微信账号备注：${currentAccount.label}` : "当前微信账号还没有备注名。",
            message.contextToken,
          );
          return;
        }

        const account = this.store.updateAccountLabel(message.botId, command.label);
        this.snapshot.wechat = this.buildWechatState();
        if (command.mode === "clear") {
          await this.sendWechatText(
            message.botId,
            message.fromUserId,
            "已清空当前微信账号备注名。",
            message.contextToken,
          );
          this.pushEvent("info", `Cleared WeChat bot label for ${message.botId}.`);
          return;
        }

        await this.sendWechatText(
          message.botId,
          message.fromUserId,
          `已将当前微信账号备注为：${account?.label || command.label || ""}`,
          message.contextToken,
        );
        this.pushEvent("info", `Renamed WeChat bot ${message.botId} to ${account?.label || command.label}.`);
        return;
      }

      if (command.type === "new") {
        const threadId = await this.createNewThreadForUser(message.botId, message.fromUserId);
        await this.sendWechatText(message.botId, message.fromUserId, `已切换到新会话：${threadId}`, message.contextToken);
        this.pushEvent("info", `Created a new Codex thread for ${message.fromUserId}: ${threadId}`);
        return;
      }

      const state = this.store.loadState();
      const session = this.getOrCreateThreadSession(state, message.botId, message.fromUserId);

      if (command.type === "list") {
        if (session.threads.length === 0) {
          await this.sendWechatText(message.botId, message.fromUserId, "当前还没有会话，直接发消息或输入 /new 创建一个新会话。", message.contextToken);
          return;
        }

        const lines = ["当前会话列表：", "使用 /use 序号 切换最稳，也支持唯一的 thread 片段。"];
        session.threads.forEach((thread, index) => {
          lines.push(
            `${index + 1}. ${thread.threadId}${thread.threadId === session.activeThreadId ? " (当前)" : ""} | cwd: ${this.formatThreadCwd(thread)}`,
          );
        });
        await this.sendWechatText(message.botId, message.fromUserId, lines.join("\n"), message.contextToken);
        return;
      }

      const selected = this.resolveThreadSelection(session, command.target);
      if (selected.status === "missing") {
        try {
          const externalThreadId = await this.codexBridge.activateThread(command.target);
          this.markThreadActive(session, externalThreadId, Date.now(), {
            displayCwd: command.displayCwd ?? null,
            cwdSource: "attached_external",
          });
          this.persistThreadSession(state, message.botId, message.fromUserId, session);
          this.setSnapshotThread(externalThreadId, state);
          await this.sendWechatText(
            message.botId,
            message.fromUserId,
            `已接入外部会话：${externalThreadId}${command.displayCwd ? ` | cwd: ${command.displayCwd}` : ""}`,
            message.contextToken,
          );
          this.pushEvent("info", `Attached external Codex thread for ${message.fromUserId}: ${externalThreadId}.`);
          return;
        } catch {
          await this.sendWechatText(
            message.botId,
            message.fromUserId,
            "没有找到对应会话，也无法恢复这个外部 Codex 会话 ID。请确认 thread id 是否正确。",
            message.contextToken,
          );
          return;
        }
      }
      if (selected.status === "ambiguous") {
        await this.sendWechatText(
          message.botId,
          message.fromUserId,
          `匹配到多个会话，请改用 /use 序号：\n${selected.matches.map((threadId, index) => `${index + 1}. ${threadId}`).join("\n")}`,
          message.contextToken,
        );
        return;
      }

      this.markThreadActive(
        session,
        selected.threadId,
        Date.now(),
        command.displayCwd
          ? {
              displayCwd: command.displayCwd,
              cwdSource: session.threads.find((thread) => thread.threadId === selected.threadId)?.cwdSource ?? "unknown",
            }
          : undefined,
      );
      this.persistThreadSession(state, message.botId, message.fromUserId, session);
      this.setSnapshotThread(selected.threadId, state);
      await this.sendWechatText(
        message.botId,
        message.fromUserId,
        `已切换到会话：${selected.threadId}${command.displayCwd ? ` | cwd: ${command.displayCwd}` : ""}`,
        message.contextToken,
      );
      this.pushEvent("info", `Switched ${message.fromUserId} to Codex thread ${selected.threadId}.`);
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error);
      this.snapshot.agent.status = "error";
      this.persistRuntimeState(this.snapshot.codex.status, "error", messageText);
      this.pushEvent("error", `Failed to handle thread command for ${message.fromUserId}: ${messageText}`);
    } finally {
      if (this.snapshot.agent.status !== "stopped") {
        this.snapshot.agent.status = this.running ? "running" : "stopped";
      }
      this.publish();
    }
  }

  private async cancelTyping(): Promise<void> {
    if (this.typingInterval) {
      clearInterval(this.typingInterval);
      this.typingInterval = null;
    }

    if (this.currentTypingTarget) {
      try {
        await this.sendWechatTypingIndicator(
          this.currentTypingTarget.botId,
          this.currentTypingTarget.userId,
          "cancel",
          this.currentTypingTarget.contextToken || undefined,
        );
      } catch {
        // Ignore typing cancel failures during shutdown.
      }
    }

    this.currentTypingTarget = null;
  }

  private shouldDeferForMedia(message: InboundMessage): boolean {
    return (message.media || []).some((media) => media.kind === "image" || media.kind === "file");
  }

  private appendPendingMedia(message: InboundMessage): number {
    const key = this.getPendingMediaKey(message.botId, message.fromUserId);
    const existing = this.pendingMediaByUser.get(key);
    const nextMessages = existing ? [...existing.messages, message] : [message];
    this.pendingMediaByUser.set(key, {
      messages: nextMessages,
      createdAt: existing?.createdAt || Date.now(),
    });
    return nextMessages.length;
  }

  private peekPendingMedia(botId: string, userId: string): InboundMessage[] | null {
    const pending = this.pendingMediaByUser.get(this.getPendingMediaKey(botId, userId));
    if (!pending) {
      return null;
    }
    return pending.messages;
  }

  private clearPendingMedia(botId: string, userId: string): void {
    this.pendingMediaByUser.delete(this.getPendingMediaKey(botId, userId));
  }

  private async deferMediaMessage(message: InboundMessage): Promise<void> {
    try {
      const pendingCount = this.appendPendingMedia(message);
      const pendingMessages = this.peekPendingMedia(message.botId, message.fromUserId) || [message];
      await this.sendWechatText(
        message.botId,
        message.fromUserId,
        this.buildMediaReceiptText(this.collectDeferredMedia(pendingMessages)),
        message.contextToken,
      );
      this.pushEvent(
        "info",
        `Deferred ${this.describeDeferredMedia(message)} from ${message.fromUserId}; waiting for text follow-up (${pendingCount} pending).`,
      );
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error);
      this.snapshot.agent.status = "error";
      this.persistRuntimeState(this.snapshot.codex.status, "error", messageText);
      this.pushEvent("error", `Failed to defer media message for ${message.fromUserId}: ${messageText}`);
    } finally {
      if (this.snapshot.agent.status !== "stopped") {
        this.snapshot.agent.status = this.running ? "running" : "stopped";
      }
      this.publish();
    }
  }

  private describeDeferredMedia(message: InboundMessage): string {
    const labels = (message.media || [])
      .filter((media) => media.kind === "image" || media.kind === "file")
      .map((media) => (media.kind === "image" ? "image" : `file${media.fileName ? ` ${media.fileName}` : ""}`));
    return labels.join(", ") || "media";
  }

  private buildPrompt(message: InboundMessage, pendingMedia: InboundMessage[] | null): string {
    if (!pendingMedia || pendingMedia.length === 0) {
      if (message.voice?.transcript) {
        return `来自用户 ${message.fromUserId} 的语音转写：${message.voice.transcript}`;
      }
      return `来自用户 ${message.fromUserId}：${message.text}`;
    }

    const sections = [`来自用户 ${message.fromUserId}：`];
    sections.push(`用户先发送了${this.describeDeferredMediaType(this.collectDeferredMedia(pendingMedia))}，请结合这些内容回答。`);

    for (const pendingMessage of pendingMedia) {
      sections.push(this.describePendingMessage(pendingMessage));
    }

    sections.push("用户随后补充说明：");
    sections.push(message.voice?.transcript ? `语音转写：${message.voice.transcript}` : message.text);
    return sections.join("\n");
  }

  private describePendingMessage(message: InboundMessage): string {
    const lines: string[] = [];
    const compactText = this.compactText(message.text);
    if (compactText && !this.isSyntheticMediaPlaceholder(compactText)) {
      lines.push(compactText);
    }

    for (const media of message.media || []) {
      if (media.kind !== "image" && media.kind !== "file") {
        continue;
      }
      lines.push(
        media.kind === "image"
          ? `图片路径: ${media.path}`
          : `文件路径: ${media.path}${media.fileName ? ` (原文件名: ${media.fileName})` : ""}`,
      );
    }

    return lines.join("\n");
  }

  private isSyntheticMediaPlaceholder(text: string): boolean {
    return (
      text === "[收到图片]" ||
      text === "[收到文件]" ||
      /^\[(Image|File) /.test(text)
    );
  }

  private describeMessageForLog(message: InboundMessage): string {
    const compactText = this.compactText(message.text);
    if (compactText) {
      return compactText;
    }

    const mediaSummary = this.describeDeferredMediaType(message.media || []);
    return mediaSummary ? `[${mediaSummary}]` : "[empty message]";
  }

  private collectDeferredMedia(messages: InboundMessage[]): InboundMedia[] {
    return messages.flatMap((message) => message.media || []).filter((media) => media.kind === "image" || media.kind === "file");
  }

  private describeDeferredMediaType(mediaItems: InboundMedia[]): string {
    const hasImage = mediaItems.some((media) => media.kind === "image");
    const hasFile = mediaItems.some((media) => media.kind === "file");

    if (hasImage && hasFile) {
      return "图片和文件";
    }
    if (hasImage) {
      return "图片";
    }
    if (hasFile) {
      return "文件";
    }
    return "消息";
  }

  private buildMediaReceiptText(mediaItems: InboundMedia[]): string {
    return `已经收到你的${this.describeDeferredMediaType(mediaItems)}了，请问你要我做什么？`;
  }

  private startQrPolling(): void {
    this.stopQrPolling();
    this.qrPollInterval = setInterval(() => {
      void this.pollQrStatus();
    }, 2_000);
  }

  private stopQrPolling(): void {
    if (this.qrPollInterval) {
      clearInterval(this.qrPollInterval);
      this.qrPollInterval = null;
    }
  }

  private async pollQrStatus(): Promise<void> {
    try {
      const result = await this.wechatClient.checkQrStatus();
      this.snapshot.wechat.qrStatus = result.status;

      if (result.status === "confirmed") {
        this.stopQrPolling();
        this.snapshot.wechat = this.buildWechatState();
        this.pushEvent("info", "WeChat login confirmed.");
      } else if (result.status === "expired") {
        const qr = await this.wechatClient.startQrLogin(true);
        this.snapshot.wechat.loginState = "logging_in";
        this.snapshot.wechat.qrStatus = qr.qrStatus;
        this.snapshot.wechat.qrText = qr.qrText;
        this.snapshot.wechat.qrPath = qr.qrPath;
        this.snapshot.wechat.qrUrl = qr.qrUrl;
        this.pushEvent("warn", "The WeChat QR code expired and was refreshed automatically.");
      } else {
        this.snapshot.wechat.loginState = "logging_in";
      }

      this.publish();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.pushEvent("error", `WeChat login status check failed: ${message}`);
      this.publish();
    }
  }

  private buildWechatState(): WechatCardState {
    const accounts = this.wechatClient.getAccounts();
    const account = this.wechatClient.getAccount() || accounts[0] || null;
    return {
      loginState: account ? "logged_in" : "logged_out",
      botId: account?.botId || null,
      userId: account?.userId || null,
      activeBotId: account?.botId || null,
      connectedBotCount: accounts.length,
      bots: accounts.map((item) => ({
        botId: item.botId,
        userId: item.userId,
        label: item.label || null,
        lastPollAt: null,
      })),
      qrStatus: null,
      qrText: null,
      qrPath: null,
      qrUrl: null,
      lastPollAt: null,
    };
  }

  private buildCodexState(): CodexCardState {
    const runtimeState = this.store.loadState();
    const threadId = this.findMostRecentThreadId(runtimeState);
    return {
      available: false,
      version: null,
      status: runtimeState.codexStatus,
      threadId,
      threadCwd: this.findThreadCwdLabel(runtimeState, threadId),
      lastConnectedAt: null,
      lastError: runtimeState.lastError,
    };
  }

  private pushEvent(level: RuntimeEvent["level"], message: string): void {
    const event: RuntimeEvent = {
      id: randomUUID(),
      level,
      timestamp: Date.now(),
      message,
    };

    this.snapshot.events = [...this.snapshot.events.slice(-199), event];
    this.publish();
  }

  private persistRuntimeState(codexStatus: CodexStatus, agentStatus: AgentStatus, lastError: string | null): void {
    const nextState = this.store.loadState();
    nextState.codexStatus = codexStatus;
    nextState.agentStatus = agentStatus;
    nextState.lastError = lastError;
    this.store.saveState(nextState);
  }

  private pruneRuntimeStateForBot(botId: string): void {
    const nextState = this.store.loadState();
    nextState.contextTokens = Object.fromEntries(
      Object.entries(nextState.contextTokens).filter(([key]) => !key.startsWith(`${botId}:`)),
    );
    nextState.threadSessions = Object.fromEntries(
      Object.entries(nextState.threadSessions).filter(([key]) => !key.startsWith(`${botId}:`)),
    );
    if (nextState.updatesBufByBot) {
      delete nextState.updatesBufByBot[botId];
    }
    if (nextState.lastMessageIdByBot) {
      delete nextState.lastMessageIdByBot[botId];
    }
    this.store.saveState(nextState);
  }

  private async ensureMessageThread(botId: string, userId: string): Promise<string> {
    const state = this.store.loadState();
    const session = this.getOrCreateThreadSession(state, botId, userId);
    const requestedThreadId = session.activeThreadId;
    const resolvedThreadId = await this.codexBridge.ensureThread(requestedThreadId);
    const now = Date.now();

    if (requestedThreadId && requestedThreadId !== resolvedThreadId) {
      this.pushEvent("warn", `Failed to resume thread ${requestedThreadId} for ${userId}; switched to ${resolvedThreadId}.`);
    }

    this.markThreadActive(
      session,
      resolvedThreadId,
      now,
      !requestedThreadId || requestedThreadId !== resolvedThreadId
        ? {
            displayCwd: process.cwd(),
            cwdSource: "created_here",
          }
        : undefined,
    );
    this.persistThreadSession(state, botId, userId, session);
    this.setSnapshotThread(resolvedThreadId, state);
    this.snapshot.codex.lastConnectedAt = now;
    return resolvedThreadId;
  }

  private async createNewThreadForUser(botId: string, userId: string): Promise<string> {
    const state = this.store.loadState();
    const session = this.getOrCreateThreadSession(state, botId, userId);
    const threadId = await this.codexBridge.createThread();
    const now = Date.now();
    this.markThreadActive(session, threadId, now, {
      displayCwd: process.cwd(),
      cwdSource: "created_here",
    });
    this.persistThreadSession(state, botId, userId, session);
    this.setSnapshotThread(threadId, state);
    this.snapshot.codex.lastConnectedAt = now;
    return threadId;
  }

  private getOrCreateThreadSession(state: RuntimeState, botId: string, userId: string): UserThreadSession {
    const key = this.getThreadSessionKey(botId, userId);
    const existing = state.threadSessions[key];
    if (existing) {
      return existing;
    }

    if (state.legacySharedThreadId) {
      const migratedAt = Date.now();
      const migrated: UserThreadSession = {
        activeThreadId: state.legacySharedThreadId,
        lastUsedAt: migratedAt,
        threads: [
          {
            threadId: state.legacySharedThreadId,
            createdAt: migratedAt,
            lastUsedAt: migratedAt,
            displayCwd: null,
            cwdSource: "unknown",
          },
        ],
      };
      state.threadSessions[key] = migrated;
      state.legacySharedThreadId = null;
      return migrated;
    }

    const created: UserThreadSession = {
      activeThreadId: null,
      lastUsedAt: null,
      threads: [],
    };
    state.threadSessions[key] = created;
    return created;
  }

  private persistThreadSession(state: RuntimeState, botId: string, userId: string, session: UserThreadSession): void {
    state.threadSessions[this.getThreadSessionKey(botId, userId)] = session;
    state.legacySharedThreadId = null;
    this.store.saveState(state);
  }

  private getThreadSessionKey(botId: string, userId: string): string {
    return `${botId}:${userId}`;
  }

  private markThreadActive(
    session: UserThreadSession,
    threadId: string,
    timestamp: number,
    metadata?: { displayCwd: string | null; cwdSource: ThreadCwdSource },
  ): void {
    const existing = session.threads.find((thread) => thread.threadId === threadId);
    if (existing) {
      existing.lastUsedAt = timestamp;
      if (metadata) {
        existing.displayCwd = metadata.displayCwd;
        existing.cwdSource = metadata.cwdSource;
      }
    } else {
      session.threads.push({
        threadId,
        createdAt: timestamp,
        lastUsedAt: timestamp,
        displayCwd: metadata?.displayCwd ?? null,
        cwdSource: metadata?.cwdSource ?? "unknown",
      });
    }
    session.activeThreadId = threadId;
    session.lastUsedAt = timestamp;
  }

  private resolveThreadSelection(session: UserThreadSession, target: string): ThreadSelectionResult {
    const numericIndex = Number.parseInt(target, 10);
    if (Number.isInteger(numericIndex) && String(numericIndex) === target) {
      const thread = session.threads[numericIndex - 1];
      if (thread) {
        return { status: "selected", threadId: thread.threadId };
      }
    }

    const exactMatch = session.threads.find((thread) => thread.threadId === target);
    if (exactMatch) {
      return { status: "selected", threadId: exactMatch.threadId };
    }

    const uniquePrefix = this.findUniqueThreadMatch(session, (threadId) => threadId.startsWith(target));
    if (uniquePrefix.status !== "missing") {
      return uniquePrefix;
    }

    const uniqueSuffix = this.findUniqueThreadMatch(session, (threadId) => threadId.endsWith(target));
    if (uniqueSuffix.status !== "missing") {
      return uniqueSuffix;
    }

    return this.findUniqueThreadMatch(session, (threadId) => threadId.includes(target));
  }

  private findUniqueThreadMatch(session: UserThreadSession, predicate: (threadId: string) => boolean): ThreadSelectionResult {
    const matches = session.threads
      .map((thread) => thread.threadId)
      .filter(predicate);
    if (matches.length === 0) {
      return { status: "missing" };
    }
    if (matches.length > 1) {
      return { status: "ambiguous", matches };
    }
    return { status: "selected", threadId: matches[0] };
  }

  private findMostRecentThreadId(state: RuntimeState): string | null {
    let latestThreadId = state.legacySharedThreadId || null;
    let latestTimestamp = -1;

    for (const session of Object.values(state.threadSessions)) {
      if (!session.activeThreadId) {
        continue;
      }
      const activeThread = session.threads.find((thread) => thread.threadId === session.activeThreadId);
      const timestamp = activeThread?.lastUsedAt ?? session.lastUsedAt ?? -1;
      if (timestamp >= latestTimestamp) {
        latestThreadId = session.activeThreadId;
        latestTimestamp = timestamp;
      }
    }

    return latestThreadId;
  }

  private setSnapshotThread(threadId: string | null, state = this.store.loadState()): void {
    this.snapshot.codex.threadId = threadId;
    this.snapshot.codex.threadCwd = this.findThreadCwdLabel(state, threadId);
  }

  private findThreadRecord(state: RuntimeState, threadId: string): CodexThreadRecord | null {
    for (const session of Object.values(state.threadSessions)) {
      const matched = session.threads.find((thread) => thread.threadId === threadId);
      if (matched) {
        return matched;
      }
    }
    return null;
  }

  private findThreadCwdLabel(state: RuntimeState, threadId: string | null): string | null {
    if (!threadId) {
      return null;
    }

    const thread = this.findThreadRecord(state, threadId);
    return this.formatThreadCwd(thread);
  }

  private formatThreadCwd(thread: Pick<CodexThreadRecord, "displayCwd" | "cwdSource"> | null | undefined): string {
    if (thread?.displayCwd) {
      return thread.displayCwd;
    }

    if (thread?.cwdSource === "attached_external") {
      return "unknown (external thread)";
    }

    return "unknown";
  }

  private getPendingMediaKey(botId: string, userId: string): string {
    return `${botId}:${userId}`;
  }

  private updateBotLastPollAt(botId: string, timestamp: number): void {
    this.snapshot.wechat.lastPollAt = timestamp;
    this.snapshot.wechat.bots = this.snapshot.wechat.bots.map((bot) =>
      bot.botId === botId ? { ...bot, lastPollAt: timestamp } : bot,
    );
  }

  private async deliverWechatReplyChunk(
    botId: string,
    userId: string,
    chunk: { visibleText: string; filePaths: string[] },
    eventPrefix: string,
    contextToken?: string,
  ): Promise<void> {
    for (const textPart of splitWechatReplyText(chunk.visibleText)) {
      await this.sendWechatText(botId, userId, textPart, contextToken);
      this.pushEvent("info", `${eventPrefix} to ${userId}: ${this.compactText(textPart)}`);
    }

    for (const filePath of chunk.filePaths) {
      try {
        await this.sendWechatFile(botId, userId, filePath, contextToken);
        this.pushEvent("info", `Sent local file back to ${userId}: ${filePath}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.pushEvent("error", `Failed to send local file to ${userId}: ${message}`);
        try {
          await this.sendWechatText(botId, userId, `文件回传失败：${message}`, contextToken);
        } catch {
          // Ignore secondary delivery failures; the event log already captured the root cause.
        }
      }
    }
  }

  private async sendWechatText(botId: string, userId: string, text: string, contextToken?: string): Promise<void> {
    if (contextToken) {
      await this.wechatClient.sendText(userId, text, contextToken, botId);
      return;
    }

    await this.wechatClient.sendText(userId, text, undefined, botId);
  }

  private async sendWechatTypingIndicator(
    botId: string,
    userId: string,
    status: "typing" | "cancel",
    contextToken?: string,
  ): Promise<void> {
    if (contextToken) {
      await this.wechatClient.sendTypingIndicator(userId, status, contextToken, botId);
      return;
    }

    await this.wechatClient.sendTypingIndicator(userId, status, undefined, botId);
  }

  private async sendWechatFile(botId: string, userId: string, filePath: string, contextToken?: string): Promise<void> {
    if (contextToken) {
      await this.wechatClient.sendLocalFile(userId, filePath, contextToken, botId);
      return;
    }

    await this.wechatClient.sendLocalFile(userId, filePath, undefined, botId);
  }

  private appendWechatReplyText(buffer: string, chunk: string): string {
    const normalizedChunk = chunk.trim();
    if (!normalizedChunk) {
      return buffer;
    }

    if (!buffer) {
      return normalizedChunk;
    }

    if (buffer.endsWith("\n") || normalizedChunk.startsWith("\n")) {
      return `${buffer}${normalizedChunk}`;
    }

    return `${buffer}\n${normalizedChunk}`;
  }

  private compactText(text: string): string {
    const compact = text.replace(/\s+/g, " ").trim();
    return compact.length > 80 ? `${compact.slice(0, 77)}...` : compact;
  }

  private publish(): void {
    const snapshot = this.getSnapshot();
    for (const listener of this.listeners) {
      listener(snapshot);
    }
  }
}
