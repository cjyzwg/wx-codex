import { createCipheriv, createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { FileItem, ImageItem, MessageItem, SendMessageReq, VideoItem } from "../types.js";
import { generateId, getUploadUrl, sendMessage } from "./api.js";
import { WECHAT_CDN_BASE_URL, getMimeFromFilename } from "./mediaDownload.js";

const UploadMediaType = {
  IMAGE: 1,
  VIDEO: 2,
  FILE: 3,
} as const;

const MessageType = {
  BOT: 2,
} as const;

const MessageState = {
  FINISH: 2,
} as const;

const MessageItemType = {
  IMAGE: 2,
  FILE: 4,
  VIDEO: 5,
} as const;

type UploadedFileInfo = {
  downloadEncryptedQueryParam: string;
  aesKeyHex: string;
  fileSize: number;
  fileSizeCiphertext: number;
};

function encryptAesEcb(plaintext: Buffer, key: Buffer): Buffer {
  const cipher = createCipheriv("aes-128-ecb", key, null);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

function aesEcbPaddedSize(plaintextSize: number): number {
  return Math.ceil((plaintextSize + 1) / 16) * 16;
}

function buildCdnUploadUrl(params: {
  cdnBaseUrl: string;
  uploadParam: string;
  filekey: string;
}): string {
  return `${params.cdnBaseUrl}/upload?encrypted_query_param=${encodeURIComponent(params.uploadParam)}&filekey=${encodeURIComponent(params.filekey)}`;
}

async function uploadBufferToCdn(params: {
  buffer: Buffer;
  uploadParam: string;
  filekey: string;
  cdnBaseUrl: string;
  aesKey: Buffer;
}): Promise<string> {
  const ciphertext = encryptAesEcb(params.buffer, params.aesKey);
  const response = await fetch(
    buildCdnUploadUrl({
      cdnBaseUrl: params.cdnBaseUrl,
      uploadParam: params.uploadParam,
      filekey: params.filekey,
    }),
    {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: new Uint8Array(ciphertext),
    },
  );

  if (response.status !== 200) {
    const errorText = response.headers.get("x-error-message")
      || await response.text().catch(() => "(unreadable)");
    throw new Error(`CDN upload failed: ${response.status} ${errorText}`);
  }

  const downloadParam = response.headers.get("x-encrypted-param");
  if (!downloadParam) {
    throw new Error("CDN upload response missing x-encrypted-param.");
  }

  return downloadParam;
}

async function uploadLocalFile(params: {
  baseUrl: string;
  token?: string;
  toUserId: string;
  filePath: string;
  mediaType: number;
  cdnBaseUrl: string;
}): Promise<UploadedFileInfo> {
  const plaintext = fs.readFileSync(params.filePath);
  const rawSize = plaintext.length;
  const rawFileMd5 = createHash("md5").update(plaintext).digest("hex");
  const fileSizeCiphertext = aesEcbPaddedSize(rawSize);
  const fileKey = randomBytes(16).toString("hex");
  const aesKey = randomBytes(16);

  const uploadParams = await getUploadUrl({
    baseUrl: params.baseUrl,
    token: params.token,
    filekey: fileKey,
    media_type: params.mediaType,
    to_user_id: params.toUserId,
    rawsize: rawSize,
    rawfilemd5: rawFileMd5,
    filesize: fileSizeCiphertext,
    no_need_thumb: true,
    aeskey: aesKey.toString("hex"),
  });

  if (!uploadParams.upload_param) {
    throw new Error("WeChat getUploadUrl returned no upload_param.");
  }

  const downloadEncryptedQueryParam = await uploadBufferToCdn({
    buffer: plaintext,
    uploadParam: uploadParams.upload_param,
    filekey: fileKey,
    cdnBaseUrl: params.cdnBaseUrl,
    aesKey,
  });

  return {
    downloadEncryptedQueryParam,
    aesKeyHex: aesKey.toString("hex"),
    fileSize: rawSize,
    fileSizeCiphertext,
  };
}

function buildSendRequest(params: {
  toUserId: string;
  contextToken: string;
  mediaItem: MessageItem;
}): SendMessageReq {
  return {
    msg: {
      from_user_id: "",
      to_user_id: params.toUserId,
      client_id: generateId("wxcodex"),
      message_type: MessageType.BOT,
      message_state: MessageState.FINISH,
      item_list: [params.mediaItem],
      context_token: params.contextToken,
    },
  };
}

function buildImageItem(uploaded: UploadedFileInfo): MessageItem {
  const imageItem: ImageItem = {
    media: {
      encrypt_query_param: uploaded.downloadEncryptedQueryParam,
      aes_key: Buffer.from(uploaded.aesKeyHex, "hex").toString("base64"),
      encrypt_type: 1,
    },
    mid_size: uploaded.fileSizeCiphertext,
  };

  return {
    type: MessageItemType.IMAGE,
    image_item: imageItem,
  };
}

function buildVideoItem(uploaded: UploadedFileInfo): MessageItem {
  const videoItem: VideoItem = {
    media: {
      encrypt_query_param: uploaded.downloadEncryptedQueryParam,
      aes_key: Buffer.from(uploaded.aesKeyHex, "hex").toString("base64"),
      encrypt_type: 1,
    },
    video_size: uploaded.fileSizeCiphertext,
  };

  return {
    type: MessageItemType.VIDEO,
    video_item: videoItem,
  };
}

function buildFileItem(fileName: string, uploaded: UploadedFileInfo): MessageItem {
  const fileItem: FileItem = {
    media: {
      encrypt_query_param: uploaded.downloadEncryptedQueryParam,
      aes_key: Buffer.from(uploaded.aesKeyHex, "hex").toString("base64"),
      encrypt_type: 1,
    },
    file_name: fileName,
    len: String(uploaded.fileSize),
  };

  return {
    type: MessageItemType.FILE,
    file_item: fileItem,
  };
}

export async function sendLocalFileToWechat(params: {
  baseUrl: string;
  token?: string;
  contextToken: string;
  toUserId: string;
  filePath: string;
  cdnBaseUrl?: string;
}): Promise<void> {
  const resolvedPath = path.resolve(params.filePath);
  const mimeType = getMimeFromFilename(resolvedPath);
  const cdnBaseUrl = params.cdnBaseUrl || WECHAT_CDN_BASE_URL;

  const mediaType = mimeType.startsWith("image/")
    ? UploadMediaType.IMAGE
    : mimeType.startsWith("video/")
      ? UploadMediaType.VIDEO
      : UploadMediaType.FILE;

  const uploaded = await uploadLocalFile({
    baseUrl: params.baseUrl,
    token: params.token,
    toUserId: params.toUserId,
    filePath: resolvedPath,
    mediaType,
    cdnBaseUrl,
  });

  const mediaItem = mediaType === UploadMediaType.IMAGE
    ? buildImageItem(uploaded)
    : mediaType === UploadMediaType.VIDEO
      ? buildVideoItem(uploaded)
      : buildFileItem(path.basename(resolvedPath), uploaded);

  await sendMessage({
    baseUrl: params.baseUrl,
    token: params.token,
    body: buildSendRequest({
      toUserId: params.toUserId,
      contextToken: params.contextToken,
      mediaItem,
    }),
  });
}
