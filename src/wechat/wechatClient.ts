import fs from "node:fs";
import path from "node:path";
import QRCode from "qrcode";

import type { AccountData, InboundMedia, InboundMessage, InboundVoice, QRStatusResponse, QrStatus, RuntimeState, WeixinMessage } from "../types.js";
import { WechatStore } from "../store/wechatStore.js";
import { downloadInboundFile, downloadInboundImage } from "./mediaDownload.js";
import { sendLocalFileToWechat } from "./mediaUpload.js";
import { fetchQrCode, generateId, getConfig, getUpdates, pollQrStatus, sendMessage, sendTyping } from "./api.js";

const DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com";
const QR_TTL_MS = 5 * 60_000;

const MessageType = {
  USER: 1,
  BOT: 2,
} as const;

const MessageItemType = {
  TEXT: 1,
} as const;

const MessageState = {
  FINISH: 2,
} as const;

export class WechatClient {
  constructor(private readonly store: WechatStore) {}

  getAccounts(): AccountData[] {
    return this.store.loadAccounts();
  }

  getAccount(botId?: string): AccountData | null {
    return this.store.loadAccount(botId);
  }

  getState(): RuntimeState {
    return this.store.loadState();
  }

  saveState(state: RuntimeState): void {
    this.store.saveState(state);
  }

  setActiveBotId(botId: string | null): void {
    this.store.setActiveBotId(botId);
  }

  async startQrLogin(forceNew = false): Promise<{
    qrStatus: QrStatus;
    qrText: string;
    qrPath: string;
    qrUrl: string;
  }> {
    const existingQrState = this.store.loadQrState();
    if (!forceNew && existingQrState && Date.now() - existingQrState.createdAt < QR_TTL_MS) {
      const qrText = this.store.readQrText() || (await this.writeQrArtifacts(existingQrState.qrcodeUrl));
      return {
        qrStatus: "wait",
        qrText,
        qrPath: this.store.getQrPngPath(),
        qrUrl: existingQrState.qrcodeUrl,
      };
    }

    const qrResponse = await fetchQrCode(DEFAULT_BASE_URL);
    this.store.saveQrState({
      qrcode: qrResponse.qrcode,
      qrcodeUrl: qrResponse.qrcode_img_content,
      createdAt: Date.now(),
    });

    const qrText = await this.writeQrArtifacts(qrResponse.qrcode_img_content);
    return {
      qrStatus: "wait",
      qrText,
      qrPath: this.store.getQrPngPath(),
      qrUrl: qrResponse.qrcode_img_content,
    };
  }

  async checkQrStatus(): Promise<QRStatusResponse> {
    const qrState = this.store.loadQrState();
    if (!qrState) {
      const account = this.store.loadAccount();
      if (account) {
        return {
          status: "confirmed",
          bot_token: account.botToken,
          ilink_bot_id: account.botId,
          ilink_user_id: account.userId,
          baseurl: account.baseUrl,
        };
      }
      throw new Error("No QR login in progress.");
    }

    if (Date.now() - qrState.createdAt >= QR_TTL_MS) {
      this.store.clearQrState();
      return { status: "expired" };
    }

    const result = await pollQrStatus(DEFAULT_BASE_URL, qrState.qrcode);
    if (result.status === "confirmed") {
      if (!result.bot_token || !result.ilink_bot_id || !result.ilink_user_id) {
        throw new Error("Login confirmed but the server response was incomplete.");
      }

      this.store.saveAccount({
        botToken: result.bot_token,
        botId: result.ilink_bot_id,
        userId: result.ilink_user_id,
        baseUrl: result.baseurl || DEFAULT_BASE_URL,
        savedAt: Date.now(),
      });
      this.store.clearQrState();
    } else if (result.status === "expired") {
      this.store.clearQrState();
    }

    return result;
  }

  clearLogin(botId?: string): RuntimeState {
    this.store.clearQrState();
    this.store.clearAccount(botId);
    if (botId) {
      return this.store.loadState();
    }
    return this.store.resetState();
  }

  async pollMessages(params: { timeoutMs: number; signal?: AbortSignal; botId?: string }): Promise<InboundMessage[]> {
    const account = this.requireAccount(params.botId);
    const state = this.store.loadState();
    const hasPerBotState = Boolean(state.updatesBufByBot && Object.keys(state.updatesBufByBot).length > 0);
    const updatesBuf = state.updatesBufByBot?.[account.botId] ?? (!hasPerBotState ? state.updatesBuf : "");

    const response = await getUpdates({
      baseUrl: account.baseUrl,
      token: account.botToken,
      updatesBuf,
      timeoutMs: params.timeoutMs,
      signal: params.signal,
    });

    if (response.errcode) {
      throw new Error(`WeChat getUpdates failed: ${response.errcode} ${response.errmsg || ""}`.trim());
    }

    const nextState = { ...state };
    if (response.get_updates_buf) {
      nextState.updatesBuf = response.get_updates_buf;
      nextState.updatesBufByBot = {
        ...(nextState.updatesBufByBot || {}),
        [account.botId]: response.get_updates_buf,
      };
    }

    const newMessages = (response.msgs || []).filter(
      (message) => message.message_type === MessageType.USER,
    );

    if (newMessages.length > 0) {
      nextState.lastMessageId = Math.max(...newMessages.map((message) => message.message_id || 0));
      nextState.lastMessageIdByBot = {
        ...(nextState.lastMessageIdByBot || {}),
        [account.botId]: nextState.lastMessageId,
      };
      for (const message of newMessages) {
        const key = `${account.botId}:${message.from_user_id}`;
        if (message.context_token) {
          nextState.contextTokens[key] = message.context_token;
        }
      }
    }

    this.store.saveState(nextState);
    return Promise.all(newMessages.map((message) => this.formatMessage(account.botId, message)));
  }

  async sendText(to: string, text: string, contextTokenOverride?: string, botId?: string): Promise<void> {
    const account = this.requireAccount(botId);
    const contextToken = this.resolveContextToken(account.botId, to, contextTokenOverride);

    await sendMessage({
      baseUrl: account.baseUrl,
      token: account.botToken,
      body: {
        msg: {
          from_user_id: "",
          to_user_id: to,
          client_id: generateId("wxcodex"),
          message_type: MessageType.BOT,
          message_state: MessageState.FINISH,
          item_list: [{ type: MessageItemType.TEXT, text_item: { text } }],
          context_token: contextToken,
        },
      },
    });
  }

  async sendTypingIndicator(to: string, status: "typing" | "cancel", contextTokenOverride?: string, botId?: string): Promise<void> {
    const account = this.requireAccount(botId);
    const contextToken = this.resolveContextToken(account.botId, to, contextTokenOverride);
    if (!contextToken) {
      throw new Error(`No WeChat conversation context found for user ${to}.`);
    }

    const config = await getConfig({
      baseUrl: account.baseUrl,
      token: account.botToken,
      ilinkUserId: to,
      contextToken,
    });

    if (config.errmsg) {
      throw new Error(`WeChat getConfig failed: ${config.errmsg}`);
    }

    await sendTyping({
      baseUrl: account.baseUrl,
      token: account.botToken,
      body: {
        ilink_user_id: to,
        typing_ticket: config.typing_ticket,
        status: status === "typing" ? 1 : 2,
      },
    });
  }

  async sendLocalFile(to: string, filePath: string, contextTokenOverride?: string, botId?: string): Promise<void> {
    const account = this.requireAccount(botId);
    if (!path.isAbsolute(filePath)) {
      throw new Error(`WeChat file send only supports absolute paths: ${filePath}`);
    }
    const resolvedPath = path.resolve(filePath);

    if (!fs.existsSync(resolvedPath)) {
      throw new Error(`WeChat file send target does not exist: ${resolvedPath}`);
    }

    const contextToken = this.resolveContextToken(account.botId, to, contextTokenOverride);
    if (!contextToken) {
      throw new Error(`No WeChat conversation context found for user ${to}.`);
    }

    await sendLocalFileToWechat({
      baseUrl: account.baseUrl,
      token: account.botToken,
      contextToken,
      toUserId: to,
      filePath: resolvedPath,
    });
  }

  private requireAccount(botId?: string): AccountData {
    const account = this.store.loadAccount(botId);
    if (!account) {
      throw new Error("WeChat is not logged in.");
    }
    return account;
  }

  private resolveContextToken(botId: string, to: string, contextTokenOverride?: string): string | undefined {
    if (contextTokenOverride?.trim()) {
      return contextTokenOverride.trim();
    }

    const state = this.store.loadState();
    return state.contextTokens[`${botId}:${to}`];
  }

  private async writeQrArtifacts(url: string): Promise<string> {
    this.store.ensureDataDir();
    const qrText = await QRCode.toString(url, { type: "terminal" });
    await QRCode.toFile(this.store.getQrPngPath(), url, { width: 400, margin: 2 });
    fs.writeFileSync(this.store.getQrTxtPath(), qrText, { encoding: "utf8" });
    return qrText;
  }

  private async formatMessage(botId: string, message: WeixinMessage): Promise<InboundMessage> {
    const textParts: string[] = [];
    const media: InboundMedia[] = [];
    const items = message.item_list || [];
    let voice: InboundVoice | undefined;
    let directReplyText: string | undefined;

    for (const [index, item] of items.entries()) {
      switch (item.type) {
        case 1:
          textParts.push(item.text_item?.text || "");
          break;
        case 2:
          try {
            const savedImage = await downloadInboundImage({
              imageItem: item.image_item,
              mediaDir: this.store.getInboundMediaDir(),
              messageId: message.message_id || 0,
              itemIndex: index,
            });

            if (savedImage) {
              media.push({
                kind: "image",
                path: savedImage.path,
                source: "item",
                contentType: savedImage.contentType,
              });
            } else {
              textParts.push("[收到图片]");
            }
          } catch (error) {
            const messageText = error instanceof Error ? error.message : String(error);
            textParts.push(`[图片下载失败: ${messageText}]`);
          }
          break;
        case 3:
          if (item.voice_item?.text?.trim()) {
            const transcript = item.voice_item.text.trim();
            voice = {
              transcript,
              durationMs: item.voice_item.playtime ?? null,
              sampleRate: item.voice_item.sample_rate ?? null,
            };
            textParts.push(transcript);
          } else {
            directReplyText = "这条语音暂时没有拿到可用的转写文本，请再发一次文字试试。";
          }
          break;
        case 4:
          try {
            const savedFile = await downloadInboundFile({
              fileItem: item.file_item,
              mediaDir: this.store.getInboundMediaDir(),
              messageId: message.message_id || 0,
              itemIndex: index,
            });

            if (savedFile) {
              media.push({
                kind: "file",
                path: savedFile.path,
                source: "item",
                contentType: savedFile.contentType,
                fileName: savedFile.fileName,
              });
            } else {
              textParts.push(item.file_item?.file_name ? `[收到文件: ${item.file_item.file_name}]` : "[收到文件]");
            }
          } catch (error) {
            const messageText = error instanceof Error ? error.message : String(error);
            textParts.push(`[文件下载失败: ${messageText}]`);
          }
          break;
        case 5:
          directReplyText = "该消息类型不支持";
          textParts.push("[Unsupported video message]");
          break;
        default:
          break;
      }
    }

    let text = textParts.join("\n").trim();
    if (message.ref_msg) {
      const quoted = message.ref_msg.message_item?.text_item?.text || message.ref_msg.title || "";
      text = `[Reply to: ${quoted}]\n${text}`.trim();
    }

    return {
      messageId: message.message_id || 0,
      botId,
      fromUserId: message.from_user_id || "",
      toUserId: message.to_user_id || "",
      text,
      contextToken: message.context_token,
      createTime: message.create_time_ms ? new Date(message.create_time_ms).toISOString() : undefined,
      media,
      voice,
      rawMessage: message,
      directReplyText,
    };
  }
}
