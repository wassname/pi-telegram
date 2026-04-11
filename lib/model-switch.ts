/**
 * In-flight Telegram model-switch helpers
 * Encodes the safe restart and continuation rules for switching models during active Telegram-owned runs
 */

import type { Model } from "@mariozechner/pi-ai";

import type { TelegramInFlightModelSwitchState } from "./queue.ts";

export type TelegramThinkingLevel =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh";

export function canRestartTelegramTurnForModelSwitch(
  state: TelegramInFlightModelSwitchState,
): boolean {
  return !state.isIdle && state.hasActiveTelegramTurn && state.hasAbortHandler;
}

export function shouldTriggerPendingTelegramModelSwitchAbort(state: {
  hasPendingModelSwitch: boolean;
  hasActiveTelegramTurn: boolean;
  hasAbortHandler: boolean;
  activeToolExecutions: number;
}): boolean {
  return (
    state.hasPendingModelSwitch &&
    state.hasActiveTelegramTurn &&
    state.hasAbortHandler &&
    state.activeToolExecutions === 0
  );
}

export function restartTelegramModelSwitchContinuation<TTurn, TSelection>(state: {
  activeTurn: TTurn | undefined;
  abort: (() => void) | undefined;
  selection: TSelection;
  queueContinuation: (turn: TTurn, selection: TSelection) => void;
}): boolean {
  if (!state.activeTurn || !state.abort) return false;
  state.queueContinuation(state.activeTurn, state.selection);
  state.abort();
  return true;
}

export function buildTelegramModelSwitchContinuationText<
  TModel extends Pick<Model<any>, "provider" | "id">,
>(
  telegramPrefix: string,
  model: TModel,
  thinkingLevel?: TelegramThinkingLevel,
): string {
  const modelLabel = `${model.provider}/${model.id}`;
  const thinkingSuffix = thinkingLevel
    ? ` Keep the selected thinking level (${thinkingLevel}) if it still applies.`
    : "";
  return `${telegramPrefix} Continue the interrupted previous Telegram request using the newly selected model (${modelLabel}). Resume from the last unfinished step instead of restarting from scratch unless necessary.${thinkingSuffix}`;
}
