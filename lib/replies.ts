/**
 * Telegram reply and preview domain helpers
 * Owns preview text decisions, preview runtime behavior, rendered-message delivery, and plain or markdown reply sending
 */

import type { TelegramRenderedChunk, TelegramRenderMode } from "./rendering.ts";

// --- Preview ---

export interface TelegramPreviewStateLike {
  mode: "draft" | "message";
  draftId?: number;
  messageId?: number;
  pendingText: string;
  lastSentText: string;
}

export interface TelegramPreviewRuntimeState extends TelegramPreviewStateLike {
  flushTimer?: ReturnType<typeof setTimeout>;
}

export interface TelegramPreviewRuntimeDeps {
  getState: () => TelegramPreviewRuntimeState | undefined;
  setState: (state: TelegramPreviewRuntimeState | undefined) => void;
  clearScheduledFlush: (state: TelegramPreviewRuntimeState) => void;
  maxMessageLength: number;
  renderPreviewText: (markdown: string) => string;
  getDraftSupport: () => "unknown" | "supported" | "unsupported";
  setDraftSupport: (support: "unknown" | "supported" | "unsupported") => void;
  allocateDraftId: () => number;
  sendDraft: (chatId: number, draftId: number, text: string) => Promise<void>;
  sendMessage: (
    chatId: number,
    text: string,
  ) => Promise<TelegramSentMessageLike>;
  editMessageText: (
    chatId: number,
    messageId: number,
    text: string,
  ) => Promise<void>;
  renderTelegramMessage: (
    text: string,
    options?: { mode?: TelegramRenderMode },
  ) => TelegramRenderedChunk[];
  sendRenderedChunks: (
    chatId: number,
    chunks: TelegramRenderedChunk[],
  ) => Promise<number | undefined>;
  editRenderedMessage: (
    chatId: number,
    messageId: number,
    chunks: TelegramRenderedChunk[],
  ) => Promise<number | undefined>;
}

const PREVIEW_TRUNCATION_NOTICE = "\n[preview truncated]";

function truncateTelegramPreviewText(
  text: string,
  maxMessageLength: number,
): string {
  if (text.length <= maxMessageLength) return text;
  if (maxMessageLength <= PREVIEW_TRUNCATION_NOTICE.length + 1) {
    return text.slice(0, maxMessageLength);
  }
  const visibleLength = Math.max(
    0,
    maxMessageLength - PREVIEW_TRUNCATION_NOTICE.length - 1,
  );
  return `${text.slice(0, visibleLength)}…${PREVIEW_TRUNCATION_NOTICE}`;
}

export function buildTelegramPreviewFlushText(options: {
  state: TelegramPreviewStateLike;
  maxMessageLength: number;
  renderPreviewText: (markdown: string) => string;
}): string | undefined {
  const rawText = options.state.pendingText.trim();
  const previewText = options.renderPreviewText(rawText).trim();
  if (!previewText || previewText === options.state.lastSentText) {
    return undefined;
  }
  return truncateTelegramPreviewText(previewText, options.maxMessageLength);
}

export function buildTelegramPreviewFinalText(
  state: TelegramPreviewStateLike,
): string | undefined {
  const finalText = (state.pendingText.trim() || state.lastSentText).trim();
  return finalText || undefined;
}

export function shouldUseTelegramDraftPreview(options: {
  draftSupport: "unknown" | "supported" | "unsupported";
}): boolean {
  return options.draftSupport !== "unsupported";
}

export async function clearTelegramPreview(
  chatId: number,
  deps: TelegramPreviewRuntimeDeps,
): Promise<void> {
  const state = deps.getState();
  if (!state) return;
  deps.clearScheduledFlush(state);
  deps.setState(undefined);
  if (state.mode !== "draft" || state.draftId === undefined) return;
  try {
    await deps.sendDraft(chatId, state.draftId, "");
  } catch {
    // ignore
  }
}

export async function flushTelegramPreview(
  chatId: number,
  deps: TelegramPreviewRuntimeDeps,
): Promise<void> {
  const state = deps.getState();
  if (!state) return;
  state.flushTimer = undefined;
  const truncated = buildTelegramPreviewFlushText({
    state,
    maxMessageLength: deps.maxMessageLength,
    renderPreviewText: deps.renderPreviewText,
  });
  if (!truncated) return;
  if (shouldUseTelegramDraftPreview({ draftSupport: deps.getDraftSupport() })) {
    const draftId = state.draftId ?? deps.allocateDraftId();
    state.draftId = draftId;
    try {
      await deps.sendDraft(chatId, draftId, truncated);
      deps.setDraftSupport("supported");
      state.mode = "draft";
      state.lastSentText = truncated;
      return;
    } catch {
      deps.setDraftSupport("unsupported");
    }
  }
  if (state.messageId === undefined) {
    const sent = await deps.sendMessage(chatId, truncated);
    state.messageId = sent.message_id;
    state.mode = "message";
    state.lastSentText = truncated;
    return;
  }
  await deps.editMessageText(chatId, state.messageId, truncated);
  state.mode = "message";
  state.lastSentText = truncated;
}

export async function finalizeTelegramPreview(
  chatId: number,
  deps: TelegramPreviewRuntimeDeps,
): Promise<boolean> {
  const state = deps.getState();
  if (!state) return false;
  await flushTelegramPreview(chatId, deps);
  const finalText = buildTelegramPreviewFinalText(state);
  if (!finalText) {
    await clearTelegramPreview(chatId, deps);
    return false;
  }
  if (state.mode === "draft") {
    await deps.sendMessage(chatId, finalText);
    await clearTelegramPreview(chatId, deps);
    return true;
  }
  deps.setState(undefined);
  return state.messageId !== undefined;
}

export async function finalizeTelegramMarkdownPreview(
  chatId: number,
  markdown: string,
  deps: TelegramPreviewRuntimeDeps,
): Promise<boolean> {
  const state = deps.getState();
  if (!state) return false;
  await flushTelegramPreview(chatId, deps);
  const chunks = deps.renderTelegramMessage(markdown, { mode: "markdown" });
  if (chunks.length === 0) {
    await clearTelegramPreview(chatId, deps);
    return false;
  }
  if (state.mode === "draft") {
    await deps.sendRenderedChunks(chatId, chunks);
    await clearTelegramPreview(chatId, deps);
    return true;
  }
  if (state.messageId === undefined) return false;
  await deps.editRenderedMessage(chatId, state.messageId, chunks);
  deps.setState(undefined);
  return true;
}

// --- Delivery ---

export interface TelegramSentMessageLike {
  message_id: number;
}

export interface TelegramReplyDeliveryDeps<TReplyMarkup> {
  sendMessage: (body: {
    chat_id: number;
    text: string;
    parse_mode?: "HTML";
    reply_markup?: TReplyMarkup;
  }) => Promise<TelegramSentMessageLike>;
  editMessage: (body: {
    chat_id: number;
    message_id: number;
    text: string;
    parse_mode?: "HTML";
    reply_markup?: TReplyMarkup;
  }) => Promise<void>;
}

export interface TelegramReplyTransport<TReplyMarkup> {
  sendRenderedChunks: (
    chatId: number,
    chunks: TelegramRenderedChunk[],
    options?: { replyMarkup?: TReplyMarkup },
  ) => Promise<number | undefined>;
  editRenderedMessage: (
    chatId: number,
    messageId: number,
    chunks: TelegramRenderedChunk[],
    options?: { replyMarkup?: TReplyMarkup },
  ) => Promise<number | undefined>;
}

export function buildTelegramReplyTransport<TReplyMarkup>(
  deps: TelegramReplyDeliveryDeps<TReplyMarkup>,
): TelegramReplyTransport<TReplyMarkup> {
  return {
    sendRenderedChunks: async (chatId, chunks, options) => {
      return sendTelegramRenderedChunks(chatId, chunks, deps, options);
    },
    editRenderedMessage: async (chatId, messageId, chunks, options) => {
      return editTelegramRenderedMessage(
        chatId,
        messageId,
        chunks,
        deps,
        options,
      );
    },
  };
}

export async function sendTelegramRenderedChunks<TReplyMarkup>(
  chatId: number,
  chunks: TelegramRenderedChunk[],
  deps: TelegramReplyDeliveryDeps<TReplyMarkup>,
  options?: { replyMarkup?: TReplyMarkup },
): Promise<number | undefined> {
  let lastMessageId: number | undefined;
  for (const [index, chunk] of chunks.entries()) {
    const sent = await deps.sendMessage({
      chat_id: chatId,
      text: chunk.text,
      parse_mode: chunk.parseMode,
      reply_markup:
        index === chunks.length - 1 ? options?.replyMarkup : undefined,
    });
    lastMessageId = sent.message_id;
  }
  return lastMessageId;
}

export async function editTelegramRenderedMessage<TReplyMarkup>(
  chatId: number,
  messageId: number,
  chunks: TelegramRenderedChunk[],
  deps: TelegramReplyDeliveryDeps<TReplyMarkup>,
  options?: { replyMarkup?: TReplyMarkup },
): Promise<number | undefined> {
  if (chunks.length === 0) return messageId;
  const [firstChunk, ...remainingChunks] = chunks;
  await deps.editMessage({
    chat_id: chatId,
    message_id: messageId,
    text: firstChunk.text,
    parse_mode: firstChunk.parseMode,
    reply_markup:
      remainingChunks.length === 0 ? options?.replyMarkup : undefined,
  });
  if (remainingChunks.length > 0) {
    return sendTelegramRenderedChunks(chatId, remainingChunks, deps, options);
  }
  return messageId;
}

// --- Reply Runtime ---

export interface TelegramReplyRuntimeDeps {
  renderTelegramMessage: (
    text: string,
    options?: { mode?: TelegramRenderMode },
  ) => TelegramRenderedChunk[];
  sendRenderedChunks: (
    chunks: TelegramRenderedChunk[],
  ) => Promise<number | undefined>;
}

export async function sendTelegramPlainReply(
  text: string,
  deps: TelegramReplyRuntimeDeps,
  options?: { parseMode?: "HTML" },
): Promise<number | undefined> {
  const chunks = deps.renderTelegramMessage(text, {
    mode: options?.parseMode === "HTML" ? "html" : "plain",
  });
  return deps.sendRenderedChunks(chunks);
}

export async function sendTelegramMarkdownReply(
  markdown: string,
  deps: TelegramReplyRuntimeDeps,
): Promise<number | undefined> {
  const chunks = deps.renderTelegramMessage(markdown, { mode: "markdown" });
  if (chunks.length === 0) {
    return sendTelegramPlainReply(markdown, deps);
  }
  return deps.sendRenderedChunks(chunks);
}
