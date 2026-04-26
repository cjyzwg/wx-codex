import fs from "node:fs";
import path from "node:path";

import type { AccountData, CodexThreadRecord, QrLoginState, RuntimeState, StoredAccountsData, ThreadCwdSource, UserThreadSession } from "../types.js";

function normalizeCwdSource(value: unknown, displayCwd: string | null): ThreadCwdSource {
  if (value === "created_here" || value === "attached_external" || value === "unknown") {
    return value;
  }
  return displayCwd ? "created_here" : "unknown";
}

function normalizeThreadRecord(value: unknown): CodexThreadRecord | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const raw = value as Partial<CodexThreadRecord> & { displayCwd?: unknown; cwdSource?: unknown };
  if (typeof raw.threadId !== "string" || !raw.threadId) {
    return null;
  }

  const displayCwd = typeof raw.displayCwd === "string" && raw.displayCwd.length > 0 ? raw.displayCwd : null;
  return {
    threadId: raw.threadId,
    createdAt: typeof raw.createdAt === "number" ? raw.createdAt : 0,
    lastUsedAt: typeof raw.lastUsedAt === "number" ? raw.lastUsedAt : typeof raw.createdAt === "number" ? raw.createdAt : 0,
    displayCwd,
    cwdSource: normalizeCwdSource(raw.cwdSource, displayCwd),
  };
}

function normalizeThreadSession(value: unknown): UserThreadSession | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const raw = value as Partial<UserThreadSession>;
  const threads = Array.isArray(raw.threads)
    ? raw.threads
        .map((thread) => normalizeThreadRecord(thread))
        .filter((thread): thread is CodexThreadRecord => thread !== null)
    : [];

  return {
    activeThreadId: typeof raw.activeThreadId === "string" ? raw.activeThreadId : null,
    lastUsedAt:
      typeof raw.lastUsedAt === "number"
        ? raw.lastUsedAt
        : threads.length > 0
          ? Math.max(...threads.map((thread) => thread.lastUsedAt))
          : null,
    threads,
  };
}

function normalizeThreadSessions(value: unknown): RuntimeState["threadSessions"] {
  if (!value || typeof value !== "object") {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value).flatMap(([key, session]) => {
      const normalized = normalizeThreadSession(session);
      return normalized ? [[key, normalized]] : [];
    }),
  );
}

function createDefaultRuntimeState(): RuntimeState {
  return {
    updatesBuf: "",
    updatesBufByBot: {},
    contextTokens: {},
    lastMessageId: 0,
    lastMessageIdByBot: {},
    threadSessions: {},
    legacySharedThreadId: null,
    agentStatus: "stopped",
    codexStatus: "disconnected",
    lastError: null,
  };
}

export class WechatStore {
  constructor(private readonly dataDir: string) {}

  ensureDataDir(): void {
    fs.mkdirSync(this.dataDir, { recursive: true });
  }

  getDataDir(): string {
    return this.dataDir;
  }

  getQrPngPath(): string {
    return path.join(this.dataDir, "qrcode.png");
  }

  getQrTxtPath(): string {
    return path.join(this.dataDir, "qrcode.txt");
  }

  getInboundMediaDir(): string {
    return path.join(this.dataDir, "inbound");
  }

  private accountPath(): string {
    return path.join(this.dataDir, "account.json");
  }

  private statePath(): string {
    return path.join(this.dataDir, "state.json");
  }

  private qrStatePath(): string {
    return path.join(this.dataDir, "qr_login.json");
  }

  loadAccounts(): AccountData[] {
    const raw = this.readJson<AccountData | Partial<StoredAccountsData>>(this.accountPath());
    if (!raw) {
      return [];
    }

    if (Array.isArray((raw as StoredAccountsData).accounts)) {
      return (raw as StoredAccountsData).accounts.filter((account): account is AccountData => Boolean(account?.botId && account?.botToken));
    }

    const legacy = raw as Partial<AccountData>;
    if (legacy.botId && legacy.botToken && legacy.userId && legacy.baseUrl) {
      return [
        {
          botToken: legacy.botToken,
          botId: legacy.botId,
          userId: legacy.userId,
          baseUrl: legacy.baseUrl,
          savedAt: typeof legacy.savedAt === "number" ? legacy.savedAt : 0,
          label: typeof legacy.label === "string" && legacy.label.length > 0 ? legacy.label : undefined,
        },
      ];
    }

    return [];
  }

  loadAccount(botId?: string): AccountData | null {
    const accounts = this.loadAccounts();
    if (accounts.length === 0) {
      return null;
    }

    if (botId) {
      return accounts.find((account) => account.botId === botId) || null;
    }

    const raw = this.readJson<Partial<StoredAccountsData>>(this.accountPath());
    const activeBotId = raw && !Array.isArray(raw) ? raw.activeBotId : null;
    return accounts.find((account) => account.botId === activeBotId) || accounts[0] || null;
  }

  saveAccounts(accounts: AccountData[], activeBotId: string | null = accounts[0]?.botId || null): void {
    this.writeJson(this.accountPath(), {
      activeBotId,
      accounts,
    } satisfies StoredAccountsData);
    try {
      fs.chmodSync(this.accountPath(), 0o600);
    } catch {
      // Best effort only.
    }
  }

  setActiveBotId(botId: string | null): void {
    const accounts = this.loadAccounts();
    const nextActiveBotId = botId && accounts.some((account) => account.botId === botId) ? botId : accounts[0]?.botId || null;
    this.saveAccounts(accounts, nextActiveBotId);
  }

  saveAccount(account: AccountData): void {
    const accounts = this.loadAccounts();
    const existingIndex = accounts.findIndex((item) => item.botId === account.botId);
    if (existingIndex >= 0) {
      accounts[existingIndex] = account;
    } else {
      accounts.push(account);
    }
    this.saveAccounts(accounts, account.botId);
  }

  updateAccountLabel(botId: string, label: string | null): AccountData | null {
    const accounts = this.loadAccounts();
    const existingIndex = accounts.findIndex((item) => item.botId === botId);
    if (existingIndex < 0) {
      return null;
    }

    const normalizedLabel = label?.trim() ? label.trim() : undefined;
    accounts[existingIndex] = {
      ...accounts[existingIndex],
      label: normalizedLabel,
    };
    this.saveAccounts(accounts, this.loadAccount()?.botId || botId);
    return accounts[existingIndex];
  }

  clearAccount(botId?: string): void {
    if (!botId) {
      this.unlinkIfExists(this.accountPath());
      return;
    }

    const currentActiveBotId = this.loadAccount()?.botId || null;
    const accounts = this.loadAccounts().filter((account) => account.botId !== botId);
    if (accounts.length === 0) {
      this.unlinkIfExists(this.accountPath());
      return;
    }

    const nextActiveBotId = currentActiveBotId === botId ? accounts[0]?.botId || null : currentActiveBotId;
    this.saveAccounts(accounts, nextActiveBotId);
  }

  loadState(): RuntimeState {
    const raw = this.readJson<(Partial<RuntimeState> & { sharedThreadId?: string | null })>(this.statePath());
    if (!raw) {
      return createDefaultRuntimeState();
    }

    return {
      updatesBuf: raw.updatesBuf || "",
      updatesBufByBot: raw.updatesBufByBot || {},
      contextTokens: raw.contextTokens || {},
      lastMessageId: raw.lastMessageId || 0,
      lastMessageIdByBot: raw.lastMessageIdByBot || {},
      threadSessions: normalizeThreadSessions(raw.threadSessions),
      legacySharedThreadId: raw.legacySharedThreadId ?? raw.sharedThreadId ?? null,
      agentStatus: raw.agentStatus || "stopped",
      codexStatus: raw.codexStatus || "disconnected",
      lastError: raw.lastError || null,
    };
  }

  saveState(state: RuntimeState): void {
    this.writeJson(this.statePath(), {
      updatesBuf: state.updatesBuf,
      updatesBufByBot: state.updatesBufByBot || {},
      contextTokens: state.contextTokens,
      lastMessageId: state.lastMessageId,
      lastMessageIdByBot: state.lastMessageIdByBot || {},
      threadSessions: state.threadSessions,
      agentStatus: state.agentStatus,
      codexStatus: state.codexStatus,
      lastError: state.lastError,
    });
  }

  loadQrState(): QrLoginState | null {
    return this.readJson<QrLoginState>(this.qrStatePath());
  }

  saveQrState(state: QrLoginState): void {
    this.writeJson(this.qrStatePath(), state);
  }

  clearQrState(): void {
    this.unlinkIfExists(this.qrStatePath());
    this.unlinkIfExists(this.getQrPngPath());
    this.unlinkIfExists(this.getQrTxtPath());
  }

  readQrText(): string | null {
    try {
      return fs.readFileSync(this.getQrTxtPath(), { encoding: "utf8" });
    } catch {
      return null;
    }
  }

  resetState(): RuntimeState {
    const nextState = createDefaultRuntimeState();
    this.saveState(nextState);
    return nextState;
  }

  private readJson<T>(filePath: string): T | null {
    try {
      const raw = fs.readFileSync(filePath, { encoding: "utf8" });
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }

  private writeJson(filePath: string, data: unknown): void {
    this.ensureDataDir();
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), { encoding: "utf8" });
  }

  private unlinkIfExists(filePath: string): void {
    try {
      fs.unlinkSync(filePath);
    } catch {
      // Ignore missing files.
    }
  }
}
