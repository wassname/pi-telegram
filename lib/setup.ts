/**
 * Telegram setup prompt helpers
 * Computes token-prefill defaults and prompt mode selection for /telegram-setup
 */

export interface TelegramBotTokenPromptSpec {
  method: "input" | "editor";
  value: string;
}

export const TELEGRAM_BOT_TOKEN_INPUT_PLACEHOLDER = "123456:ABCDEF...";
export const TELEGRAM_BOT_TOKEN_ENV_VARS = [
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_BOT_KEY",
  "TELEGRAM_TOKEN",
  "TELEGRAM_KEY",
] as const;

export function getTelegramBotTokenInputDefault(
  env: NodeJS.ProcessEnv = process.env,
  configToken?: string,
): string {
  const trimmedConfigToken = configToken?.trim();
  if (trimmedConfigToken) return trimmedConfigToken;
  for (const key of TELEGRAM_BOT_TOKEN_ENV_VARS) {
    const value = env[key]?.trim();
    if (value) return value;
  }
  return TELEGRAM_BOT_TOKEN_INPUT_PLACEHOLDER;
}

export function getTelegramBotTokenPromptSpec(
  env: NodeJS.ProcessEnv = process.env,
  configToken?: string,
): TelegramBotTokenPromptSpec {
  const value = getTelegramBotTokenInputDefault(env, configToken);
  return {
    method: value === TELEGRAM_BOT_TOKEN_INPUT_PLACEHOLDER ? "input" : "editor",
    value,
  };
}
