/**
 * Regression tests for the Telegram updates domain
 * Covers extraction, authorization, flow classification, execution planning, and runtime execution in one suite
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  buildTelegramUpdateExecutionPlan,
  buildTelegramUpdateExecutionPlanFromUpdate,
  buildTelegramUpdateFlowAction,
  collectTelegramReactionEmojis,
  executeTelegramUpdate,
  executeTelegramUpdatePlan,
  extractDeletedTelegramMessageIds,
  getAuthorizedTelegramCallbackQuery,
  getAuthorizedTelegramMessage,
  getTelegramAuthorizationState,
  normalizeTelegramReactionEmoji,
} from "../lib/updates.ts";

test("Update helpers normalize emoji reactions and collect emoji-only entries", () => {
  assert.equal(normalizeTelegramReactionEmoji("👍️"), "👍");
  const emojis = collectTelegramReactionEmojis([
    { type: "emoji", emoji: "👍️" },
    { type: "emoji", emoji: "👎" },
    { type: "custom_emoji" },
  ]);
  assert.deepEqual([...emojis], ["👍", "👎"]);
});

test("Update helpers extract deleted message ids from Telegram update variants", () => {
  assert.deepEqual(
    extractDeletedTelegramMessageIds({
      _: "other",
      deleted_business_messages: { message_ids: [1, 2] },
    }),
    [1, 2],
  );
  assert.deepEqual(
    extractDeletedTelegramMessageIds({
      _: "updateDeleteMessages",
      messages: [3, 4],
    }),
    [3, 4],
  );
  assert.deepEqual(
    extractDeletedTelegramMessageIds({
      _: "updateDeleteMessages",
      messages: [3, "bad"],
    }),
    [],
  );
});

test("Update routing classifies authorization state for allow and deny", () => {
  assert.deepEqual(getTelegramAuthorizationState(10, undefined), { kind: "deny" });
  assert.deepEqual(getTelegramAuthorizationState(10, 10), { kind: "allow" });
  assert.deepEqual(getTelegramAuthorizationState(10, 11), { kind: "deny" });
});

test("Update routing extracts only private human callback queries", () => {
  assert.equal(
    getAuthorizedTelegramCallbackQuery({
      callback_query: {
        from: { id: 1, is_bot: true },
        message: { chat: { type: "private" } },
      },
    }),
    undefined,
  );
  const query = getAuthorizedTelegramCallbackQuery({
    callback_query: {
      from: { id: 1, is_bot: false },
      message: { chat: { type: "private" } },
    },
  });
  assert.ok(query);
});

test("Update routing extracts private human messages from message or edited_message", () => {
  assert.equal(
    getAuthorizedTelegramMessage({
      message: {
        chat: { type: "group" },
        from: { id: 1, is_bot: false },
      },
    }),
    undefined,
  );
  const directMessage = getAuthorizedTelegramMessage({
    edited_message: {
      chat: { type: "private" },
      from: { id: 1, is_bot: false },
    },
  });
  assert.ok(directMessage);
});

test("Update flow prioritizes deleted-message handling over other update kinds", () => {
  const action = buildTelegramUpdateFlowAction(
    {
      _: "updateDeleteMessages",
      messages: [1, 2],
      message_reaction: {
        chat: { type: "private" },
        user: { id: 1, is_bot: false },
      },
    },
    1,
  );
  assert.deepEqual(action, { kind: "deleted", messageIds: [1, 2] });
});

test("Update flow returns authorized callback and message actions", () => {
  const callbackAction = buildTelegramUpdateFlowAction(
    {
      _: "other",
      callback_query: {
        from: { id: 7, is_bot: false },
        message: { chat: { type: "private" } },
      },
    },
    7,
  );
  assert.equal(callbackAction.kind, "callback");
  assert.deepEqual(
    callbackAction.kind === "callback" ? callbackAction.authorization : undefined,
    { kind: "allow" },
  );
  const messageAction = buildTelegramUpdateFlowAction({
    _: "other",
    message: {
      chat: { type: "private" },
      from: { id: 9, is_bot: false },
    },
  });
  assert.equal(messageAction.kind, "message");
  assert.deepEqual(
    messageAction.kind === "message" ? messageAction.authorization : undefined,
    { kind: "deny" },
  );
});

test("Update flow ignores unauthorized transport shapes and preserves reaction events", () => {
  const reactionAction = buildTelegramUpdateFlowAction({
    _: "other",
    message_reaction: {
      chat: { type: "private" },
      user: { id: 1, is_bot: false },
    },
  });
  assert.equal(reactionAction.kind, "reaction");
  const ignored = buildTelegramUpdateFlowAction({
    _: "other",
    callback_query: {
      from: { id: 1, is_bot: true },
      message: { chat: { type: "private" } },
    },
  });
  assert.deepEqual(ignored, { kind: "ignore" });
});

test("Update execution plan maps callback and message authorization to side-effect flags", () => {
  const callbackPlan = buildTelegramUpdateExecutionPlan({
    kind: "callback",
    query: {
      from: { id: 1, is_bot: false },
      message: { chat: { type: "private" } },
    },
    authorization: { kind: "deny" },
  });
  assert.deepEqual(callbackPlan, {
    kind: "callback",
    query: {
      from: { id: 1, is_bot: false },
      message: { chat: { type: "private" } },
    },
    shouldDeny: true,
  });
  const messagePlan = buildTelegramUpdateExecutionPlan({
    kind: "message",
    message: {
      chat: { type: "private" },
      from: { id: 2, is_bot: false },
    },
    authorization: { kind: "allow" },
  });
  assert.equal(messagePlan.kind, "message");
  assert.equal(messagePlan.shouldDeny, false);
});

test("Update execution plan preserves deleted and reaction actions", () => {
  assert.deepEqual(
    buildTelegramUpdateExecutionPlan({ kind: "deleted", messageIds: [1, 2] }),
    { kind: "deleted", messageIds: [1, 2] },
  );
  const reactionUpdate = {
    chat: { type: "private" },
    user: { id: 1, is_bot: false },
  };
  assert.deepEqual(
    buildTelegramUpdateExecutionPlan({
      kind: "reaction",
      reactionUpdate,
    }),
    { kind: "reaction", reactionUpdate },
  );
});

test("Update execution plan can be built directly from updates", () => {
  const plan = buildTelegramUpdateExecutionPlanFromUpdate(
    {
      _: "other",
      callback_query: {
        from: { id: 4, is_bot: false },
        message: { chat: { type: "private" } },
      },
    },
    5,
  );
  assert.equal(plan.kind, "callback");
  assert.equal(plan.kind === "callback" ? plan.shouldDeny : false, true);
});

test("Update runtime executes delete and reaction plans through the right side effects", async () => {
  const events: string[] = [];
  await executeTelegramUpdatePlan(
    { kind: "deleted", messageIds: [1, 2] },
    {
      ctx: {} as never,
      removePendingMediaGroupMessages: (ids) => {
        events.push(`media:${ids.join(',')}`);
      },
      removeQueuedTelegramTurnsByMessageIds: (ids) => {
        events.push(`queue:${ids.join(',')}`);
        return ids.length;
      },
      handleAuthorizedTelegramReactionUpdate: async () => {
        events.push("reaction");
      },
      answerCallbackQuery: async () => {},
      handleAuthorizedTelegramCallbackQuery: async () => {},
      sendTextReply: async () => undefined,
      handleAuthorizedTelegramMessage: async () => {},
    },
  );
  assert.deepEqual(events, ["media:1,2", "queue:1,2"]);
});

test("Update runtime denies messages when allowedUserId is undefined", async () => {
  const events: string[] = [];
  await executeTelegramUpdate(
    {
      _: "other",
      message: {
        chat: { id: 10, type: "private" },
        message_id: 20,
        from: { id: 7, is_bot: false },
      },
    },
    undefined,
    {
      ctx: {} as never,
      removePendingMediaGroupMessages: () => {},
      removeQueuedTelegramTurnsByMessageIds: () => 0,
      handleAuthorizedTelegramReactionUpdate: async () => {},
      onDeniedUserId: (userId) => {
        events.push(`denied:${userId}`);
      },
      answerCallbackQuery: async () => {},
      handleAuthorizedTelegramCallbackQuery: async () => {},
      sendTextReply: async (_chatId, _replyToMessageId, text) => {
        events.push(`reply:${text}`);
        return undefined;
      },
      handleAuthorizedTelegramMessage: async () => {
        events.push("message");
      },
    },
  );
  assert.deepEqual(events, ["denied:7", "reply:This bot is not authorized for your account."]);
});

test("Update runtime handles callback deny and message deny flows", async () => {
  const events: string[] = [];
  await executeTelegramUpdatePlan(
    {
      kind: "callback",
      query: {
        id: "cb",
        from: { id: 1, is_bot: false },
        message: { chat: { type: "private" } },
      },
      shouldDeny: true,
    },
    {
      ctx: {} as never,
      removePendingMediaGroupMessages: () => {},
      removeQueuedTelegramTurnsByMessageIds: () => 0,
      handleAuthorizedTelegramReactionUpdate: async () => {},
      onDeniedUserId: (userId) => {
        events.push(`denied:${userId}`);
      },
      answerCallbackQuery: async (id, text) => {
        events.push(`answer:${id}:${text}`);
      },
      handleAuthorizedTelegramCallbackQuery: async () => {
        events.push("callback");
      },
      sendTextReply: async (chatId, replyToMessageId, text) => {
        events.push(`reply:${chatId}:${replyToMessageId}:${text}`);
        return undefined;
      },
      handleAuthorizedTelegramMessage: async () => {
        events.push("message");
      },
    },
  );
  await executeTelegramUpdatePlan(
    {
      kind: "message",
      message: {
        chat: { id: 7, type: "private" },
        from: { id: 2, is_bot: false },
        message_id: 9,
      },
      shouldDeny: false,
    },
    {
      ctx: {} as never,
      removePendingMediaGroupMessages: () => {},
      removeQueuedTelegramTurnsByMessageIds: () => 0,
      handleAuthorizedTelegramReactionUpdate: async () => {},
      answerCallbackQuery: async () => {},
      handleAuthorizedTelegramCallbackQuery: async () => {},
      sendTextReply: async (chatId, replyToMessageId, text) => {
        events.push(`reply:${chatId}:${replyToMessageId}:${text}`);
        return undefined;
      },
      handleAuthorizedTelegramMessage: async () => {
        events.push("message");
      },
    },
  );
  assert.deepEqual(events, [
    "denied:1",
    "answer:cb:This bot is not authorized for your account.",
    "message",
  ]);
});
