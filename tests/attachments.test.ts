/**
 * Regression tests for the Telegram attachments domain
 * Covers attachment queueing and attachment delivery behavior in one domain-level suite
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  queueTelegramAttachments,
  sendQueuedTelegramAttachments,
} from "../lib/attachments.ts";

test("Attachment queueing adds files to the active Telegram turn", async () => {
  const activeTurn = {
    queuedAttachments: [],
  } as unknown as {
    queuedAttachments: Array<{ path: string; fileName: string }>;
  } & Parameters<typeof queueTelegramAttachments>[0]["activeTurn"];
  const result = await queueTelegramAttachments({
    activeTurn,
    paths: ["/tmp/demo.txt"],
    maxAttachmentsPerTurn: 2,
    statPath: async () => ({ isFile: () => true }),
  });
  assert.deepEqual(activeTurn.queuedAttachments, [
    { path: "/tmp/demo.txt", fileName: "demo.txt" },
  ]);
  assert.deepEqual(result.details.paths, ["/tmp/demo.txt"]);
});

test("Attachment queueing rejects missing turns, non-files, and full queues", async () => {
  await assert.rejects(
    () =>
      queueTelegramAttachments({
        activeTurn: undefined,
        paths: ["/tmp/demo.txt"],
        maxAttachmentsPerTurn: 1,
        statPath: async () => ({ isFile: () => true }),
      }),
    { message: /active Telegram turn/ },
  );
  await assert.rejects(
    () =>
      queueTelegramAttachments({
        activeTurn: { queuedAttachments: [] } as never,
        paths: ["/tmp/demo.txt"],
        maxAttachmentsPerTurn: 1,
        statPath: async () => ({ isFile: () => false }),
      }),
    { message: "Not a file: /tmp/demo.txt" },
  );
  await assert.rejects(
    () =>
      queueTelegramAttachments({
        activeTurn: {
          queuedAttachments: [{ path: "/tmp/a.txt", fileName: "a.txt" }],
        } as never,
        paths: ["/tmp/demo.txt"],
        maxAttachmentsPerTurn: 1,
        statPath: async () => ({ isFile: () => true }),
      }),
    { message: "Attachment limit reached (1)" },
  );
});

test("Attachment delivery chooses photo vs document methods from file paths", async () => {
  const sent: Array<string> = [];
  await sendQueuedTelegramAttachments(
    {
      kind: "prompt",
      chatId: 1,
      replyToMessageId: 2,
      sourceMessageIds: [],
      queueOrder: 1,
      queueLane: "default",
      laneOrder: 1,
      queuedAttachments: [
        { path: "/tmp/a.png", fileName: "a.png" },
        { path: "/tmp/b.txt", fileName: "b.txt" },
      ],
      content: [{ type: "text", text: "prompt" }],
      historyText: "history",
      statusSummary: "summary",
    },
    {
      sendMultipart: async (
        method,
        _fields,
        fileField,
        _filePath,
        fileName,
      ) => {
        sent.push(`${method}:${fileField}:${fileName}`);
      },
      sendTextReply: async () => undefined,
    },
  );
  assert.deepEqual(sent, [
    "sendPhoto:photo:a.png",
    "sendDocument:document:b.txt",
  ]);
});

test("Attachment delivery reports per-file failures via text replies", async () => {
  const replies: string[] = [];
  await sendQueuedTelegramAttachments(
    {
      kind: "prompt",
      chatId: 1,
      replyToMessageId: 2,
      sourceMessageIds: [],
      queueOrder: 1,
      queueLane: "default",
      laneOrder: 1,
      queuedAttachments: [{ path: "/tmp/a.png", fileName: "a.png" }],
      content: [{ type: "text", text: "prompt" }],
      historyText: "history",
      statusSummary: "summary",
    },
    {
      sendMultipart: async () => {
        throw new Error("upload failed");
      },
      sendTextReply: async (_chatId, _replyToMessageId, text) => {
        replies.push(text);
        return undefined;
      },
    },
  );
  assert.deepEqual(replies, ["Failed to send attachment a.png: upload failed"]);
});
