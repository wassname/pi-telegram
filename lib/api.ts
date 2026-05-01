/**
 * Telegram API and config persistence helpers
 * Wraps bot API calls, file downloads, and local config reads and writes for the bridge runtime
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface TelegramConfig {
  botToken?: string;
  botUsername?: string;
  botId?: number;
  allowedUserId?: number;
  lastUpdateId?: number;
}

interface TelegramApiResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
}

interface TelegramGetFileResult {
  file_path: string;
}

export interface TelegramApiClient {
  call: <TResponse>(
    method: string,
    body: Record<string, unknown>,
    options?: TelegramFetchOptions,
  ) => Promise<TResponse>;
  callMultipart: <TResponse>(
    method: string,
    fields: Record<string, string>,
    fileField: string,
    filePath: string,
    fileName: string,
    options?: { signal?: AbortSignal },
  ) => Promise<TResponse>;
  downloadFile: (
    fileId: string,
    suggestedName: string,
    tempDir: string,
  ) => Promise<string>;
  answerCallbackQuery: (
    callbackQueryId: string,
    text?: string,
  ) => Promise<void>;
}

function sanitizeFileName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]+/g, "_");
}

// Network-layer codes that warrant a retry. HTTP 4xx/5xx are NOT retried here -
// those go through `data.ok` / `response.ok` and are surfaced to callers so
// rate-limits and logic errors stay loud. ATTEMPT_TIMEOUT is our own per-attempt
// timeout firing; we treat it as transient but rethrow as a non-AbortError so
// it cannot masquerade as a caller-abort upstream (e.g. polling loop).
const TRANSIENT_FETCH_CODES = new Set([
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "ECONNRESET",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ATTEMPT_TIMEOUT",
]);

const DEFAULT_FETCH_ATTEMPT_TIMEOUT_MS = 5_000;
const DEFAULT_FETCH_RETRY_DELAYS_MS = [500];

export interface TelegramFetchOptions {
  signal?: AbortSignal;
  // Override per-attempt timeout. Long-poll callers (getUpdates) should pass
  // a value larger than the server-side timeout (~30s) plus margin so the
  // healthy long-poll completes without us aborting it.
  attemptTimeoutMs?: number;
  // When false, no in-memory retry is performed. Outer loops (polling) that
  // already retry by re-entering should disable this to avoid double-retry.
  retry?: boolean;
}

function transientCode(err: unknown): string | undefined {
  const e = err as { code?: string; cause?: { code?: string } };
  const code = e?.code ?? e?.cause?.code;
  if (code && TRANSIENT_FETCH_CODES.has(code)) return code;
  return undefined;
}

/**
 * fetch with bounded in-memory retry on transient network errors and a per-attempt
 * AbortController timeout so a stuck connection cannot wedge the bridge forever.
 *
 * The caller's own AbortSignal (if any) is honored - if it aborts, we re-throw
 * the original AbortError immediately and do not retry. When OUR timeout fires
 * (caller did not abort), we re-throw as a plain Error tagged with code
 * "ATTEMPT_TIMEOUT" so upstream code can't confuse it with a caller-abort.
 */
async function fetchWithRetry(
  url: string,
  init: RequestInit,
  callerSignal?: AbortSignal,
  options?: { attemptTimeoutMs?: number; retry?: boolean },
): Promise<Response> {
  const attemptTimeoutMs =
    options?.attemptTimeoutMs ?? DEFAULT_FETCH_ATTEMPT_TIMEOUT_MS;
  const retryDelays =
    options?.retry === false ? [] : DEFAULT_FETCH_RETRY_DELAYS_MS;
  for (let attempt = 0; attempt <= retryDelays.length; attempt++) {
    const timeoutCtl = new AbortController();
    const timer = setTimeout(() => timeoutCtl.abort(), attemptTimeoutMs);
    const onCallerAbort = () => timeoutCtl.abort();
    callerSignal?.addEventListener("abort", onCallerAbort, { once: true });
    let raised: unknown;
    try {
      return await fetch(url, { ...init, signal: timeoutCtl.signal });
    } catch (err) {
      if (callerSignal?.aborted) throw err;
      // Our own timeout fired - normalize to a non-AbortError so polling
      // loops that key off DOMException("AbortError") don't false-positive.
      const isOurTimeout =
        (err as { name?: string })?.name === "AbortError" &&
        timeoutCtl.signal.aborted;
      raised = isOurTimeout
        ? Object.assign(
            new Error(`fetch attempt timed out after ${attemptTimeoutMs}ms`),
            { code: "ATTEMPT_TIMEOUT" },
          )
        : err;
      const code = transientCode(raised);
      const isLast = attempt === retryDelays.length;
      if (!code || isLast) throw raised;
      const base = retryDelays[attempt];
      const jitter = Math.round(base * (0.8 + Math.random() * 0.4));
      console.warn(
        `[pi-telegram] transient fetch error ${code} on ${url.replace(/bot[^/]+/, "bot***")}, retry ${attempt + 1} in ${jitter}ms`,
      );
      await new Promise((r) => setTimeout(r, jitter));
    } finally {
      clearTimeout(timer);
      callerSignal?.removeEventListener("abort", onCallerAbort);
    }
  }
  throw new Error("fetchWithRetry: unreachable");
}

export async function readTelegramConfig(
  configPath: string,
): Promise<TelegramConfig> {
  try {
    const content = await readFile(configPath, "utf8");
    return JSON.parse(content) as TelegramConfig;
  } catch {
    return {};
  }
}

export async function writeTelegramConfig(
  agentDir: string,
  configPath: string,
  config: TelegramConfig,
): Promise<void> {
  await mkdir(agentDir, { recursive: true });
  await writeFile(
    configPath,
    JSON.stringify(config, null, "\t") + "\n",
    "utf8",
  );
}

export async function callTelegram<TResponse>(
  botToken: string | undefined,
  method: string,
  body: Record<string, unknown>,
  options?: TelegramFetchOptions,
): Promise<TResponse> {
  if (!botToken) {
    throw new Error("Telegram bot token is not configured");
  }
  const response = await fetchWithRetry(
    `https://api.telegram.org/bot${botToken}/${method}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
    options?.signal,
    {
      attemptTimeoutMs: options?.attemptTimeoutMs,
      retry: options?.retry,
    },
  );
  const data = (await response.json()) as TelegramApiResponse<TResponse>;
  if (!data.ok || data.result === undefined) {
    throw new Error(data.description || `Telegram API ${method} failed`);
  }
  return data.result;
}

export async function callTelegramMultipart<TResponse>(
  botToken: string | undefined,
  method: string,
  fields: Record<string, string>,
  fileField: string,
  filePath: string,
  fileName: string,
  options?: { signal?: AbortSignal },
): Promise<TResponse> {
  if (!botToken) {
    throw new Error("Telegram bot token is not configured");
  }
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    form.set(key, value);
  }
  const buffer = await readFile(filePath);
  form.set(fileField, new Blob([buffer]), fileName);
  const response = await fetchWithRetry(
    `https://api.telegram.org/bot${botToken}/${method}`,
    {
      method: "POST",
      body: form,
    },
    options?.signal,
  );
  const data = (await response.json()) as TelegramApiResponse<TResponse>;
  if (!data.ok || data.result === undefined) {
    throw new Error(data.description || `Telegram API ${method} failed`);
  }
  return data.result;
}

export async function downloadTelegramFile(
  botToken: string | undefined,
  fileId: string,
  suggestedName: string,
  tempDir: string,
): Promise<string> {
  if (!botToken) {
    throw new Error("Telegram bot token is not configured");
  }
  const file = await callTelegram<TelegramGetFileResult>(botToken, "getFile", {
    file_id: fileId,
  });
  await mkdir(tempDir, { recursive: true });
  const targetPath = join(
    tempDir,
    `${Date.now()}-${sanitizeFileName(suggestedName)}`,
  );
  const response = await fetchWithRetry(
    `https://api.telegram.org/file/bot${botToken}/${file.file_path}`,
    { method: "GET" },
  );
  if (!response.ok) {
    throw new Error(`Failed to download Telegram file: ${response.status}`);
  }
  const arrayBuffer = await response.arrayBuffer();
  await writeFile(targetPath, Buffer.from(arrayBuffer));
  return targetPath;
}

export async function answerTelegramCallbackQuery(
  botToken: string | undefined,
  callbackQueryId: string,
  text?: string,
): Promise<void> {
  try {
    await callTelegram<boolean>(
      botToken,
      "answerCallbackQuery",
      text
        ? { callback_query_id: callbackQueryId, text }
        : { callback_query_id: callbackQueryId },
    );
  } catch {
    // ignore
  }
}

export function createTelegramApiClient(
  getBotToken: () => string | undefined,
): TelegramApiClient {
  return {
    call: async (method, body, options) => {
      return callTelegram(getBotToken(), method, body, options);
    },
    callMultipart: async (
      method,
      fields,
      fileField,
      filePath,
      fileName,
      options,
    ) => {
      return callTelegramMultipart(
        getBotToken(),
        method,
        fields,
        fileField,
        filePath,
        fileName,
        options,
      );
    },
    downloadFile: async (fileId, suggestedName, tempDir) => {
      return downloadTelegramFile(
        getBotToken(),
        fileId,
        suggestedName,
        tempDir,
      );
    },
    answerCallbackQuery: async (callbackQueryId, text) => {
      await answerTelegramCallbackQuery(getBotToken(), callbackQueryId, text);
    },
  };
}
