/**
 * Regression tests for Telegram setup prompt defaults
 * Covers token-prefill priority across stored config, environment variables, and placeholder fallback
 */

import assert from "node:assert/strict";
import test from "node:test";

import { __telegramTestUtils } from "../index.ts";

test("Bot token input prefers stored config over env vars", () => {
  const value = __telegramTestUtils.getTelegramBotTokenInputDefault(
    {
      TELEGRAM_KEY: "key-last",
      TELEGRAM_TOKEN: "token-third",
      TELEGRAM_BOT_KEY: "key-second",
      TELEGRAM_BOT_TOKEN: "token-first",
    },
    "stored-token",
  );
  assert.equal(value, "stored-token");
});

test("Bot token input prefers the first configured Telegram env var when no config exists", () => {
  const value = __telegramTestUtils.getTelegramBotTokenInputDefault({
    TELEGRAM_KEY: "key-last",
    TELEGRAM_TOKEN: "token-third",
    TELEGRAM_BOT_KEY: "key-second",
    TELEGRAM_BOT_TOKEN: "token-first",
  });
  assert.equal(value, "token-first");
});

test("Bot token prompt uses the editor when a real prefill exists", () => {
  const prompt = __telegramTestUtils.getTelegramBotTokenPromptSpec({
    TELEGRAM_BOT_TOKEN: "token-first",
  });
  assert.deepEqual(prompt, {
    method: "editor",
    value: "token-first",
  });
});

test("Bot token prompt shows stored config before env values", () => {
  const prompt = __telegramTestUtils.getTelegramBotTokenPromptSpec(
    {
      TELEGRAM_BOT_TOKEN: "token-first",
    },
    "stored-token",
  );
  assert.deepEqual(prompt, {
    method: "editor",
    value: "stored-token",
  });
});

test("Bot token input skips blank env vars and falls back to config", () => {
  const value = __telegramTestUtils.getTelegramBotTokenInputDefault(
    {
      TELEGRAM_BOT_TOKEN: "   ",
      TELEGRAM_BOT_KEY: "",
      TELEGRAM_TOKEN: "  ",
    },
    "stored-token",
  );
  assert.equal(value, "stored-token");
});

test("Bot token input falls back to placeholder when no value exists", () => {
  const value = __telegramTestUtils.getTelegramBotTokenInputDefault({});
  assert.equal(value, "123456:ABCDEF...");
});

test("Bot token prompt uses placeholder input when no prefill exists", () => {
  const prompt = __telegramTestUtils.getTelegramBotTokenPromptSpec({});
  assert.deepEqual(prompt, {
    method: "input",
    value: "123456:ABCDEF...",
  });
});

test("readAllowedUserIdFromEnv returns undefined when env var is not set", () => {
  assert.equal(__telegramTestUtils.readAllowedUserIdFromEnv({}), undefined);
  assert.equal(__telegramTestUtils.readAllowedUserIdFromEnv({ TELEGRAM_ALLOWED_USER_ID: "  " }), undefined);
});

test("readAllowedUserIdFromEnv parses a valid positive integer", () => {
  assert.equal(__telegramTestUtils.readAllowedUserIdFromEnv({ TELEGRAM_ALLOWED_USER_ID: "123456789" }), 123456789);
  assert.equal(__telegramTestUtils.readAllowedUserIdFromEnv({ TELEGRAM_ALLOWED_USER_ID: "  42  " }), 42);
});

test("readAllowedUserIdFromEnv throws on non-integer or non-positive value", () => {
  assert.throws(
    () => __telegramTestUtils.readAllowedUserIdFromEnv({ TELEGRAM_ALLOWED_USER_ID: "notanumber" }),
    /not a valid Telegram user ID/,
  );
  assert.throws(
    () => __telegramTestUtils.readAllowedUserIdFromEnv({ TELEGRAM_ALLOWED_USER_ID: "0" }),
    /not a valid Telegram user ID/,
  );
  assert.throws(
    () => __telegramTestUtils.readAllowedUserIdFromEnv({ TELEGRAM_ALLOWED_USER_ID: "-5" }),
    /not a valid Telegram user ID/,
  );
});
