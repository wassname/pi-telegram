/**
 * Telegram attachment domain helpers
 * Owns attachment queueing and attachment delivery so Telegram file output stays in one domain module
 */

import { basename } from "node:path";

import { guessMediaType } from "./media.ts";
import type { PendingTelegramTurn } from "./queue.ts";

export interface TelegramAttachmentToolResult {
  content: Array<{ type: "text"; text: string }>;
  details: { paths: string[] };
}

export interface TelegramQueuedAttachmentDeliveryDeps {
  sendMultipart: (
    method: string,
    fields: Record<string, string>,
    fileField: string,
    filePath: string,
    fileName: string,
  ) => Promise<unknown>;
  sendTextReply: (
    chatId: number,
    replyToMessageId: number,
    text: string,
  ) => Promise<unknown>;
}

export async function queueTelegramAttachments(options: {
  activeTurn: PendingTelegramTurn | undefined;
  paths: string[];
  maxAttachmentsPerTurn: number;
  statPath: (path: string) => Promise<{ isFile(): boolean }>;
}): Promise<TelegramAttachmentToolResult> {
  if (!options.activeTurn) {
    throw new Error(
      "telegram_attach can only be used while replying to an active Telegram turn",
    );
  }
  const added: string[] = [];
  for (const inputPath of options.paths) {
    const stats = await options.statPath(inputPath);
    if (!stats.isFile()) {
      throw new Error(`Not a file: ${inputPath}`);
    }
    if (
      options.activeTurn.queuedAttachments.length >=
      options.maxAttachmentsPerTurn
    ) {
      throw new Error(
        `Attachment limit reached (${options.maxAttachmentsPerTurn})`,
      );
    }
    options.activeTurn.queuedAttachments.push({
      path: inputPath,
      fileName: basename(inputPath),
    });
    added.push(inputPath);
  }
  return {
    content: [
      {
        type: "text",
        text: `Queued ${added.length} Telegram attachment(s).`,
      },
    ],
    details: { paths: added },
  };
}

export async function sendQueuedTelegramAttachments(
  turn: PendingTelegramTurn,
  deps: TelegramQueuedAttachmentDeliveryDeps,
): Promise<void> {
  for (const attachment of turn.queuedAttachments) {
    try {
      const mediaType = guessMediaType(attachment.path);
      const method = mediaType ? "sendPhoto" : "sendDocument";
      const fieldName = mediaType ? "photo" : "document";
      await deps.sendMultipart(
        method,
        { chat_id: String(turn.chatId) },
        fieldName,
        attachment.path,
        attachment.fileName,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await deps.sendTextReply(
        turn.chatId,
        turn.replyToMessageId,
        `Failed to send attachment ${attachment.fileName}: ${message}`,
      );
    }
  }
}
