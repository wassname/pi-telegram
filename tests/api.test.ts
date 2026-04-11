/**
 * Regression tests for Telegram API and config helpers
 * Verifies config persistence and direct helper behavior around missing tokens and callback-query failures
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  answerTelegramCallbackQuery,
  callTelegram,
  createTelegramApiClient,
  downloadTelegramFile,
  readTelegramConfig,
  writeTelegramConfig,
} from "../lib/api.ts";

test("Telegram config helpers persist and reload config", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-telegram-config-"));
  const configPath = join(agentDir, "telegram.json");
  const config = {
    botToken: "123:abc",
    botUsername: "demo_bot",
    allowedUserId: 42,
  };
  await writeTelegramConfig(agentDir, configPath, config);
  const reloaded = await readTelegramConfig(configPath);
  assert.deepEqual(reloaded, config);
  const raw = await readFile(configPath, "utf8");
  assert.match(raw, /demo_bot/);
});

test("Telegram API helpers reject missing bot token for direct calls", async () => {
  await assert.rejects(() => callTelegram(undefined, "getMe", {}), {
    message: "Telegram bot token is not configured",
  });
  await assert.rejects(
    () =>
      downloadTelegramFile(
        undefined,
        "file-id",
        "demo.txt",
        join(tmpdir(), "pi-telegram-missing-token"),
      ),
    {
      message: "Telegram bot token is not configured",
    },
  );
});

test("answerTelegramCallbackQuery ignores Telegram API failures", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error("network down");
  }) as typeof fetch;
  try {
    await assert.doesNotReject(() =>
      answerTelegramCallbackQuery("123:abc", "callback-id", "ok"),
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Telegram API client resolves bot tokens lazily for wrapped calls", async () => {
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  let botToken = "123:abc";
  globalThis.fetch = (async (input) => {
    calls.push(typeof input === "string" ? input : input.toString());
    return {
      ok: true,
      json: async () => ({ ok: true, result: true }),
    } as Response;
  }) as typeof fetch;
  try {
    const client = createTelegramApiClient(() => botToken);
    await client.call("sendChatAction", { chat_id: 1, action: "typing" });
    botToken = "456:def";
    await client.answerCallbackQuery("cb-1", "ok");
    assert.match(calls[0] ?? "", /bot123:abc\/sendChatAction$/);
    assert.match(calls[1] ?? "", /bot456:def\/answerCallbackQuery$/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
