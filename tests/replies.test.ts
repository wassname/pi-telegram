/**
 * Regression tests for the Telegram replies domain
 * Covers preview decisions, rendered-message delivery, and plain or markdown reply sending in one suite
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  buildTelegramPreviewFinalText,
  buildTelegramPreviewFlushText,
  buildTelegramReplyTransport,
  clearTelegramPreview,
  editTelegramRenderedMessage,
  finalizeTelegramMarkdownPreview,
  finalizeTelegramPreview,
  flushTelegramPreview,
  sendTelegramMarkdownReply,
  sendTelegramPlainReply,
  sendTelegramRenderedChunks,
  shouldUseTelegramDraftPreview,
} from "../lib/replies.ts";

function createPreviewRuntimeHarness(state?: {
  mode: "draft" | "message";
  draftId?: number;
  messageId?: number;
  pendingText: string;
  lastSentText: string;
  flushTimer?: ReturnType<typeof setTimeout>;
}) {
  let previewState = state;
  let draftSupport: "unknown" | "supported" | "unsupported" = "unknown";
  let nextDraftId = 10;
  const events: string[] = [];
  return {
    events,
    getState: () => previewState,
    getDraftSupport: () => draftSupport,
    setDraftSupport: (support: "unknown" | "supported" | "unsupported") => {
      draftSupport = support;
    },
    deps: {
      getState: () => previewState,
      setState: (nextState: typeof previewState) => {
        previewState = nextState;
      },
      clearScheduledFlush: (nextState: NonNullable<typeof previewState>) => {
        if (!nextState.flushTimer) return;
        clearTimeout(nextState.flushTimer);
        nextState.flushTimer = undefined;
        events.push("clear-timer");
      },
      maxMessageLength: 5,
      renderPreviewText: (markdown: string) => markdown.replaceAll("*", ""),
      getDraftSupport: () => draftSupport,
      setDraftSupport: (support: "unknown" | "supported" | "unsupported") => {
        draftSupport = support;
      },
      allocateDraftId: () => nextDraftId++,
      sendDraft: async (chatId: number, draftId: number, text: string) => {
        events.push(`draft:${chatId}:${draftId}:${text}`);
      },
      sendMessage: async (chatId: number, text: string) => {
        events.push(`send:${chatId}:${text}`);
        return { message_id: 77 };
      },
      editMessageText: async (
        chatId: number,
        messageId: number,
        text: string,
      ) => {
        events.push(`edit:${chatId}:${messageId}:${text}`);
      },
      renderTelegramMessage: (text: string, options?: { mode?: string }) => [
        { text: `${options?.mode ?? "plain"}:${text}` },
      ],
      sendRenderedChunks: async (
        chatId: number,
        chunks: Array<{ text: string }>,
      ) => {
        events.push(
          `render-send:${chatId}:${chunks.map((chunk) => chunk.text).join("|")}`,
        );
        return 88;
      },
      editRenderedMessage: async (
        chatId: number,
        messageId: number,
        chunks: Array<{ text: string }>,
      ) => {
        events.push(
          `render-edit:${chatId}:${messageId}:${chunks.map((chunk) => chunk.text).join("|")}`,
        );
        return messageId;
      },
    },
  };
}

test("Reply previews build flush text only when the preview changed", () => {
  assert.equal(
    buildTelegramPreviewFlushText({
      state: {
        mode: "draft",
        pendingText: "**hello**",
        lastSentText: "",
      },
      maxMessageLength: 4096,
      renderPreviewText: (markdown) => markdown.replaceAll("*", ""),
    }),
    "hello",
  );
  assert.equal(
    buildTelegramPreviewFlushText({
      state: {
        mode: "draft",
        pendingText: "**hello**",
        lastSentText: "hello",
      },
      maxMessageLength: 4096,
      renderPreviewText: (markdown) => markdown.replaceAll("*", ""),
    }),
    undefined,
  );
});

test("Reply previews truncate long flush text and compute final text fallback", () => {
  assert.equal(
    buildTelegramPreviewFlushText({
      state: {
        mode: "message",
        pendingText: "abcdefghijklmnopqrstuvwxyz",
        lastSentText: "",
      },
      maxMessageLength: 24,
      renderPreviewText: (markdown) => markdown,
    }),
    "abc…\n[preview truncated]",
  );
  assert.equal(
    buildTelegramPreviewFinalText({
      mode: "message",
      pendingText: "   ",
      lastSentText: "saved",
    }),
    "saved",
  );
  assert.equal(
    buildTelegramPreviewFinalText({
      mode: "message",
      pendingText: "   ",
      lastSentText: "   ",
    }),
    undefined,
  );
});

test("Reply previews use drafts unless support is explicitly disabled", () => {
  assert.equal(
    shouldUseTelegramDraftPreview({ draftSupport: "unknown" }),
    true,
  );
  assert.equal(
    shouldUseTelegramDraftPreview({ draftSupport: "supported" }),
    true,
  );
  assert.equal(
    shouldUseTelegramDraftPreview({ draftSupport: "unsupported" }),
    false,
  );
});

test("Reply preview runtime prefers draft updates and can clear draft previews", async () => {
  const harness = createPreviewRuntimeHarness({
    mode: "draft",
    pendingText: "**hello**",
    lastSentText: "",
    flushTimer: setTimeout(() => {}, 1000),
  });
  await flushTelegramPreview(7, harness.deps);
  assert.deepEqual(harness.events, ["draft:7:10:hello"]);
  assert.equal(harness.getState()?.mode, "draft");
  assert.equal(harness.getState()?.draftId, 10);
  assert.equal(harness.getState()?.lastSentText, "hello");
  assert.equal(harness.getDraftSupport(), "supported");
  await clearTelegramPreview(7, harness.deps);
  assert.deepEqual(harness.events, ["draft:7:10:hello", "draft:7:10:"]);
  assert.equal(harness.getState(), undefined);
});

test("Reply preview runtime falls back to editable messages when draft delivery fails", async () => {
  const harness = createPreviewRuntimeHarness({
    mode: "draft",
    pendingText: "abcdef",
    lastSentText: "",
  });
  harness.deps.sendDraft = async () => {
    throw new Error("draft unsupported");
  };
  await flushTelegramPreview(7, harness.deps);
  assert.deepEqual(harness.events, ["send:7:abcde"]);
  assert.equal(harness.getState()?.mode, "message");
  assert.equal(harness.getState()?.messageId, 77);
  assert.equal(harness.getDraftSupport(), "unsupported");
});

test("Reply preview runtime finalizes plain and markdown previews", async () => {
  const plainHarness = createPreviewRuntimeHarness({
    mode: "message",
    messageId: 44,
    pendingText: "done",
    lastSentText: "",
  });
  plainHarness.setDraftSupport("unsupported");
  assert.equal(await finalizeTelegramPreview(7, plainHarness.deps), true);
  assert.deepEqual(plainHarness.events, ["edit:7:44:done"]);
  assert.equal(plainHarness.getState(), undefined);
  const markdownHarness = createPreviewRuntimeHarness({
    mode: "message",
    messageId: 55,
    pendingText: "done",
    lastSentText: "",
  });
  markdownHarness.setDraftSupport("unsupported");
  assert.equal(
    await finalizeTelegramMarkdownPreview(7, "**done**", markdownHarness.deps),
    true,
  );
  assert.deepEqual(markdownHarness.events, [
    "edit:7:55:done",
    "render-edit:7:55:markdown:**done**",
  ]);
  assert.equal(markdownHarness.getState(), undefined);
});

test("Reply transport forwards send and edit operations through delivery helpers", async () => {
  const events: string[] = [];
  const transport = buildTelegramReplyTransport({
    sendMessage: async (body) => {
      events.push(`send:${body.chat_id}:${body.text}`);
      return { message_id: 5 };
    },
    editMessage: async (body) => {
      events.push(`edit:${body.chat_id}:${body.message_id}:${body.text}`);
    },
  });
  assert.equal(await transport.sendRenderedChunks(7, [{ text: "one" }]), 5);
  assert.equal(await transport.editRenderedMessage(7, 9, [{ text: "two" }]), 9);
  assert.deepEqual(events, ["send:7:one", "edit:7:9:two"]);
});

test("Reply delivery sends chunks and applies reply markup only to the last chunk", async () => {
  const sentBodies: Array<Record<string, unknown>> = [];
  const messageId = await sendTelegramRenderedChunks(
    7,
    [{ text: "one" }, { text: "two", parseMode: "HTML" }],
    {
      sendMessage: async (body) => {
        sentBodies.push(body);
        return { message_id: sentBodies.length };
      },
      editMessage: async () => {},
    },
    {
      replyMarkup: {
        inline_keyboard: [[{ text: "ok", callback_data: "noop" }]],
      },
    },
  );
  assert.equal(messageId, 2);
  assert.deepEqual(sentBodies, [
    { chat_id: 7, text: "one", parse_mode: undefined, reply_markup: undefined },
    {
      chat_id: 7,
      text: "two",
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [[{ text: "ok", callback_data: "noop" }]],
      },
    },
  ]);
});

test("Reply delivery edits the first chunk and sends remaining chunks separately", async () => {
  const editedBodies: Array<Record<string, unknown>> = [];
  const sentBodies: Array<Record<string, unknown>> = [];
  const result = await editTelegramRenderedMessage(
    7,
    99,
    [{ text: "first", parseMode: "HTML" }, { text: "second" }],
    {
      sendMessage: async (body) => {
        sentBodies.push(body);
        return { message_id: 123 };
      },
      editMessage: async (body) => {
        editedBodies.push(body);
      },
    },
    {
      replyMarkup: {
        inline_keyboard: [[{ text: "ok", callback_data: "noop" }]],
      },
    },
  );
  assert.equal(result, 123);
  assert.deepEqual(editedBodies, [
    {
      chat_id: 7,
      message_id: 99,
      text: "first",
      parse_mode: "HTML",
      reply_markup: undefined,
    },
  ]);
  assert.deepEqual(sentBodies, [
    {
      chat_id: 7,
      text: "second",
      parse_mode: undefined,
      reply_markup: {
        inline_keyboard: [[{ text: "ok", callback_data: "noop" }]],
      },
    },
  ]);
});

test("Reply runtime sends plain replies using the requested parse mode", async () => {
  const sent: string[] = [];
  const messageId = await sendTelegramPlainReply(
    "hello",
    {
      renderTelegramMessage: (_text, options) => [
        { text: options?.mode === "html" ? "html" : "plain" },
      ],
      sendRenderedChunks: async (chunks) => {
        sent.push(chunks[0]?.text ?? "");
        return 7;
      },
    },
    { parseMode: "HTML" },
  );
  assert.equal(messageId, 7);
  assert.deepEqual(sent, ["html"]);
});

test("Reply runtime falls back to plain delivery when markdown rendering yields no chunks", async () => {
  const calls: Array<string> = [];
  const messageId = await sendTelegramMarkdownReply("hello", {
    renderTelegramMessage: (_text, options) => {
      if (options?.mode === "markdown") return [];
      return [{ text: options?.mode ?? "plain" }];
    },
    sendRenderedChunks: async (chunks) => {
      calls.push(chunks[0]?.text ?? "");
      return 9;
    },
  });
  assert.equal(messageId, 9);
  assert.deepEqual(calls, ["plain"]);
});
