/**
 * Telegram menu and inline-keyboard rendering helpers
 * Owns model resolution, menu state, and inline UI text and reply-markup generation for status, model, and thinking controls
 */

import type { Model } from "@mariozechner/pi-ai";

export type ThinkingLevel =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh";
export type TelegramModelScope = "all" | "scoped";

export interface ScopedTelegramModel {
  model: Model<any>;
  thinkingLevel?: ThinkingLevel;
}

export interface TelegramModelMenuState {
  chatId: number;
  messageId: number;
  page: number;
  scope: TelegramModelScope;
  scopedModels: ScopedTelegramModel[];
  allModels: ScopedTelegramModel[];
  note?: string;
  mode: "status" | "model" | "thinking";
}

export type TelegramReplyMarkup = {
  inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
};

export interface TelegramMenuMessageRuntimeDeps {
  editInteractiveMessage: (
    chatId: number,
    messageId: number,
    text: string,
    mode: "html" | "plain",
    replyMarkup: TelegramReplyMarkup,
  ) => Promise<void>;
  sendInteractiveMessage: (
    chatId: number,
    text: string,
    mode: "html" | "plain",
    replyMarkup: TelegramReplyMarkup,
  ) => Promise<number | undefined>;
}

export interface TelegramMenuEffectPort {
  answerCallbackQuery: (
    callbackQueryId: string,
    text?: string,
  ) => Promise<void>;
  updateModelMenuMessage: () => Promise<void>;
  updateThinkingMenuMessage: () => Promise<void>;
  updateStatusMessage: () => Promise<void>;
  setModel: (model: Model<any>) => Promise<boolean>;
  setCurrentModel: (model: Model<any>) => void;
  setThinkingLevel: (level: ThinkingLevel) => void;
  getCurrentThinkingLevel: () => ThinkingLevel;
  stagePendingModelSwitch: (selection: ScopedTelegramModel) => void;
  restartInterruptedTelegramTurn: (
    selection: ScopedTelegramModel,
  ) => Promise<boolean> | boolean;
}

export type TelegramStatusMenuCallbackDeps = Pick<
  TelegramMenuEffectPort,
  "updateModelMenuMessage" | "updateThinkingMenuMessage" | "answerCallbackQuery"
>;

export type TelegramThinkingMenuCallbackDeps = Pick<
  TelegramMenuEffectPort,
  "setThinkingLevel" | "getCurrentThinkingLevel" | "updateStatusMessage" | "answerCallbackQuery"
>;

export type TelegramModelMenuCallbackDeps = Pick<
  TelegramMenuEffectPort,
  | "updateModelMenuMessage"
  | "updateStatusMessage"
  | "answerCallbackQuery"
  | "setModel"
  | "setCurrentModel"
  | "setThinkingLevel"
  | "stagePendingModelSwitch"
  | "restartInterruptedTelegramTurn"
>;

export interface TelegramMenuCallbackEntryDeps {
  handleStatusAction: () => Promise<boolean>;
  handleThinkingAction: () => Promise<boolean>;
  handleModelAction: () => Promise<boolean>;
  answerCallbackQuery: (
    callbackQueryId: string,
    text?: string,
  ) => Promise<void>;
}

export const THINKING_LEVELS: readonly ThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
];
export const TELEGRAM_MODEL_PAGE_SIZE = 6;
export const MODEL_MENU_TITLE = "<b>Choose a model:</b>";

export interface BuildTelegramModelMenuStateParams {
  chatId: number;
  activeModel: Model<any> | undefined;
  availableModels: Model<any>[];
  configuredScopedModelPatterns: string[];
  cliScopedModelPatterns?: string[];
}

export type TelegramMenuCallbackAction =
  | { kind: "ignore" }
  | { kind: "status"; action: "model" | "thinking" }
  | { kind: "thinking:set"; level: string }
  | {
      kind: "model";
      action: "noop" | "scope" | "page" | "pick";
      value?: string;
    };

export type TelegramMenuMutationResult = "invalid" | "unchanged" | "changed";
export type TelegramMenuSelectionResult =
  | { kind: "invalid" }
  | { kind: "missing" }
  | { kind: "selected"; selection: ScopedTelegramModel };

export interface TelegramModelMenuPage {
  page: number;
  pageCount: number;
  start: number;
  items: ScopedTelegramModel[];
}

export interface TelegramMenuRenderPayload {
  nextMode: TelegramModelMenuState["mode"];
  text: string;
  mode: "html" | "plain";
  replyMarkup: TelegramReplyMarkup;
}

export type TelegramModelCallbackPlan =
  | { kind: "ignore" }
  | { kind: "answer"; text?: string }
  | { kind: "update-menu"; text?: string }
  | {
      kind: "refresh-status";
      selection: ScopedTelegramModel;
      callbackText: string;
      shouldApplyThinkingLevel: boolean;
    }
  | {
      kind: "switch-model";
      selection: ScopedTelegramModel;
      mode: "idle" | "restart-now" | "restart-after-tool";
      callbackText: string;
    };

export interface BuildTelegramModelCallbackPlanParams {
  data: string | undefined;
  state: TelegramModelMenuState;
  activeModel: Model<any> | undefined;
  currentThinkingLevel: ThinkingLevel;
  isIdle: boolean;
  canRestartBusyRun: boolean;
  hasActiveToolExecutions: boolean;
}

export function modelsMatch(
  a: Pick<Model<any>, "provider" | "id"> | undefined,
  b: Pick<Model<any>, "provider" | "id"> | undefined,
): boolean {
  return !!a && !!b && a.provider === b.provider && a.id === b.id;
}

export function getCanonicalModelId(
  model: Pick<Model<any>, "provider" | "id">,
): string {
  return `${model.provider}/${model.id}`;
}

export function isThinkingLevel(value: string): value is ThinkingLevel {
  return THINKING_LEVELS.includes(value as ThinkingLevel);
}

function escapeRegex(text: string): string {
  return text.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

function globMatches(text: string, pattern: string): boolean {
  let regex = "^";
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    if (char === "*") {
      regex += ".*";
      continue;
    }
    if (char === "?") {
      regex += ".";
      continue;
    }
    if (char === "[") {
      const end = pattern.indexOf("]", i + 1);
      if (end !== -1) {
        const content = pattern.slice(i + 1, end);
        regex += content.startsWith("!")
          ? `[^${content.slice(1)}]`
          : `[${content}]`;
        i = end;
        continue;
      }
    }
    regex += escapeRegex(char);
  }
  regex += "$";
  return new RegExp(regex, "i").test(text);
}

function isAliasModelId(id: string): boolean {
  if (id.endsWith("-latest")) return true;
  return !/-\d{8}$/.test(id);
}

function findExactModelReferenceMatch(
  modelReference: string,
  availableModels: Model<any>[],
): Model<any> | undefined {
  const trimmedReference = modelReference.trim();
  if (!trimmedReference) return undefined;
  const normalizedReference = trimmedReference.toLowerCase();
  const canonicalMatches = availableModels.filter(
    (model) => getCanonicalModelId(model).toLowerCase() === normalizedReference,
  );
  if (canonicalMatches.length === 1) return canonicalMatches[0];
  if (canonicalMatches.length > 1) return undefined;
  const slashIndex = trimmedReference.indexOf("/");
  if (slashIndex !== -1) {
    const provider = trimmedReference.substring(0, slashIndex).trim();
    const modelId = trimmedReference.substring(slashIndex + 1).trim();
    if (provider && modelId) {
      const providerMatches = availableModels.filter(
        (model) =>
          model.provider.toLowerCase() === provider.toLowerCase() &&
          model.id.toLowerCase() === modelId.toLowerCase(),
      );
      if (providerMatches.length === 1) return providerMatches[0];
      if (providerMatches.length > 1) return undefined;
    }
  }
  const idMatches = availableModels.filter(
    (model) => model.id.toLowerCase() === normalizedReference,
  );
  return idMatches.length === 1 ? idMatches[0] : undefined;
}

function tryMatchScopedModel(
  modelPattern: string,
  availableModels: Model<any>[],
): Model<any> | undefined {
  const exactMatch = findExactModelReferenceMatch(
    modelPattern,
    availableModels,
  );
  if (exactMatch) return exactMatch;
  const matches = availableModels.filter(
    (model) =>
      model.id.toLowerCase().includes(modelPattern.toLowerCase()) ||
      model.name?.toLowerCase().includes(modelPattern.toLowerCase()),
  );
  if (matches.length === 0) return undefined;
  const aliases = matches.filter((model) => isAliasModelId(model.id));
  const datedVersions = matches.filter((model) => !isAliasModelId(model.id));
  if (aliases.length > 0) {
    aliases.sort((a, b) => b.id.localeCompare(a.id));
    return aliases[0];
  }
  datedVersions.sort((a, b) => b.id.localeCompare(a.id));
  return datedVersions[0];
}

function parseScopedModelPattern(
  pattern: string,
  availableModels: Model<any>[],
): { model: Model<any> | undefined; thinkingLevel?: ThinkingLevel } {
  const exactMatch = tryMatchScopedModel(pattern, availableModels);
  if (exactMatch) {
    return { model: exactMatch, thinkingLevel: undefined };
  }
  const lastColonIndex = pattern.lastIndexOf(":");
  if (lastColonIndex === -1) {
    return { model: undefined, thinkingLevel: undefined };
  }
  const prefix = pattern.substring(0, lastColonIndex);
  const suffix = pattern.substring(lastColonIndex + 1);
  if (isThinkingLevel(suffix)) {
    const result = parseScopedModelPattern(prefix, availableModels);
    if (result.model) {
      return { model: result.model, thinkingLevel: suffix };
    }
    return result;
  }
  return parseScopedModelPattern(prefix, availableModels);
}

export function resolveScopedModelPatterns(
  patterns: string[],
  availableModels: Model<any>[],
): ScopedTelegramModel[] {
  const resolved: ScopedTelegramModel[] = [];
  const seen = new Set<string>();
  for (const pattern of patterns) {
    if (
      pattern.includes("*") ||
      pattern.includes("?") ||
      pattern.includes("[")
    ) {
      const colonIndex = pattern.lastIndexOf(":");
      let globPattern = pattern;
      let thinkingLevel: ThinkingLevel | undefined;
      if (colonIndex !== -1) {
        const suffix = pattern.substring(colonIndex + 1);
        if (isThinkingLevel(suffix)) {
          thinkingLevel = suffix;
          globPattern = pattern.substring(0, colonIndex);
        }
      }
      const matches = availableModels.filter(
        (model) =>
          globMatches(getCanonicalModelId(model), globPattern) ||
          globMatches(model.id, globPattern),
      );
      for (const model of matches) {
        const key = getCanonicalModelId(model);
        if (seen.has(key)) continue;
        seen.add(key);
        resolved.push({ model, thinkingLevel });
      }
      continue;
    }
    const matched = parseScopedModelPattern(pattern, availableModels);
    if (!matched.model) continue;
    const key = getCanonicalModelId(matched.model);
    if (seen.has(key)) continue;
    seen.add(key);
    resolved.push({
      model: matched.model,
      thinkingLevel: matched.thinkingLevel,
    });
  }
  return resolved;
}

export function sortScopedModels(
  models: ScopedTelegramModel[],
  currentModel: Model<any> | undefined,
): ScopedTelegramModel[] {
  const sorted = [...models];
  sorted.sort((a, b) => {
    const aIsCurrent = modelsMatch(a.model, currentModel);
    const bIsCurrent = modelsMatch(b.model, currentModel);
    if (aIsCurrent && !bIsCurrent) return -1;
    if (!aIsCurrent && bIsCurrent) return 1;
    const providerCompare = a.model.provider.localeCompare(b.model.provider);
    if (providerCompare !== 0) return providerCompare;
    return a.model.id.localeCompare(b.model.id);
  });
  return sorted;
}

function truncateTelegramButtonLabel(label: string, maxLength = 56): string {
  return label.length <= maxLength
    ? label
    : `${label.slice(0, maxLength - 1)}…`;
}

export function formatScopedModelButtonText(
  entry: ScopedTelegramModel,
  currentModel: Model<any> | undefined,
): string {
  let label = `${modelsMatch(entry.model, currentModel) ? "✅ " : ""}${entry.model.id} [${entry.model.provider}]`;
  if (entry.thinkingLevel) {
    label += ` · ${entry.thinkingLevel}`;
  }
  return truncateTelegramButtonLabel(label);
}

export function formatStatusButtonLabel(label: string, value: string): string {
  return truncateTelegramButtonLabel(`${label}: ${value}`, 64);
}

export function getModelMenuItems(
  state: TelegramModelMenuState,
): ScopedTelegramModel[] {
  return state.scope === "scoped" && state.scopedModels.length > 0
    ? state.scopedModels
    : state.allModels;
}

export function buildTelegramModelMenuState(
  params: BuildTelegramModelMenuStateParams,
): TelegramModelMenuState {
  const allModels = sortScopedModels(
    params.availableModels.map((model) => ({ model })),
    params.activeModel,
  );
  const scopedModels =
    params.configuredScopedModelPatterns.length > 0
      ? sortScopedModels(
          resolveScopedModelPatterns(
            params.configuredScopedModelPatterns,
            params.availableModels,
          ),
          params.activeModel,
        )
      : [];
  let note: string | undefined;
  if (
    params.configuredScopedModelPatterns.length > 0 &&
    scopedModels.length === 0
  ) {
    note = params.cliScopedModelPatterns
      ? "No CLI scoped models matched the current auth configuration. Showing all available models."
      : "No scoped models matched the current auth configuration. Showing all available models.";
  }
  return {
    chatId: params.chatId,
    messageId: 0,
    page: 0,
    scope: scopedModels.length > 0 ? "scoped" : "all",
    scopedModels,
    allModels,
    note,
    mode: "status",
  };
}

export function parseTelegramMenuCallbackAction(
  data: string | undefined,
): TelegramMenuCallbackAction {
  if (data === "status:model") return { kind: "status", action: "model" };
  if (data === "status:thinking") {
    return { kind: "status", action: "thinking" };
  }
  if (data?.startsWith("thinking:set:")) {
    return {
      kind: "thinking:set",
      level: data.slice("thinking:set:".length),
    };
  }
  if (data?.startsWith("model:")) {
    const [, action, value] = data.split(":");
    if (
      action === "noop" ||
      action === "scope" ||
      action === "page" ||
      action === "pick"
    ) {
      return { kind: "model", action, value };
    }
  }
  return { kind: "ignore" };
}

export function applyTelegramModelScopeSelection(
  state: TelegramModelMenuState,
  value: string | undefined,
): TelegramMenuMutationResult {
  if (value !== "all" && value !== "scoped") return "invalid";
  if (value === state.scope) return "unchanged";
  state.scope = value;
  state.page = 0;
  return "changed";
}

export function applyTelegramModelPageSelection(
  state: TelegramModelMenuState,
  value: string | undefined,
): TelegramMenuMutationResult {
  const page = Number(value);
  if (!Number.isFinite(page)) return "invalid";
  if (page === state.page) return "unchanged";
  state.page = page;
  return "changed";
}

export function getTelegramModelSelection(
  state: TelegramModelMenuState,
  value: string | undefined,
): TelegramMenuSelectionResult {
  const index = Number(value);
  if (!Number.isFinite(index)) return { kind: "invalid" };
  const selection = getModelMenuItems(state)[index];
  if (!selection) return { kind: "missing" };
  return { kind: "selected", selection };
}

export function buildTelegramModelCallbackPlan(
  params: BuildTelegramModelCallbackPlanParams,
): TelegramModelCallbackPlan {
  const action = parseTelegramMenuCallbackAction(params.data);
  if (action.kind !== "model") return { kind: "ignore" };
  if (action.action === "noop") return { kind: "answer" };
  if (action.action === "scope") {
    const result = applyTelegramModelScopeSelection(params.state, action.value);
    if (result === "invalid") {
      return { kind: "answer", text: "Unknown model scope." };
    }
    if (result === "unchanged") {
      return { kind: "answer" };
    }
    return {
      kind: "update-menu",
      text: params.state.scope === "scoped" ? "Scoped models" : "All models",
    };
  }
  if (action.action === "page") {
    const result = applyTelegramModelPageSelection(params.state, action.value);
    if (result === "invalid") {
      return { kind: "answer", text: "Invalid page." };
    }
    if (result === "unchanged") {
      return { kind: "answer" };
    }
    return { kind: "update-menu" };
  }
  if (action.action !== "pick") {
    return { kind: "answer" };
  }
  const selectionResult = getTelegramModelSelection(params.state, action.value);
  if (selectionResult.kind === "invalid") {
    return { kind: "answer", text: "Invalid model selection." };
  }
  if (selectionResult.kind === "missing") {
    return { kind: "answer", text: "Selected model is no longer available." };
  }
  const selection = selectionResult.selection;
  if (modelsMatch(selection.model, params.activeModel)) {
    return {
      kind: "refresh-status",
      selection,
      callbackText: `Model: ${selection.model.id}`,
      shouldApplyThinkingLevel:
        !!selection.thinkingLevel &&
        selection.thinkingLevel !== params.currentThinkingLevel,
    };
  }
  if (!params.isIdle) {
    if (!params.canRestartBusyRun) {
      return { kind: "answer", text: "Pi is busy. Send /stop first." };
    }
    return {
      kind: "switch-model",
      selection,
      mode: params.hasActiveToolExecutions
        ? "restart-after-tool"
        : "restart-now",
      callbackText: params.hasActiveToolExecutions
        ? `Switched to ${selection.model.id}. Restarting after the current tool finishes…`
        : `Switching to ${selection.model.id} and continuing…`,
    };
  }
  return {
    kind: "switch-model",
    selection,
    mode: "idle",
    callbackText: `Switched to ${selection.model.id}`,
  };
}

export async function handleTelegramMenuCallbackEntry(
  callbackQueryId: string,
  data: string | undefined,
  state: TelegramModelMenuState | undefined,
  deps: TelegramMenuCallbackEntryDeps,
): Promise<void> {
  if (!data) {
    await deps.answerCallbackQuery(callbackQueryId);
    return;
  }
  if (!state) {
    await deps.answerCallbackQuery(callbackQueryId, "Interactive message expired.");
    return;
  }
  const handled =
    (await deps.handleStatusAction()) ||
    (await deps.handleThinkingAction()) ||
    (await deps.handleModelAction());
  if (!handled) {
    await deps.answerCallbackQuery(callbackQueryId);
  }
}

export async function handleTelegramModelMenuCallbackAction(
  callbackQueryId: string,
  params: BuildTelegramModelCallbackPlanParams,
  deps: TelegramModelMenuCallbackDeps,
): Promise<boolean> {
  const plan = buildTelegramModelCallbackPlan(params);
  if (plan.kind === "ignore") return false;
  if (plan.kind === "answer") {
    await deps.answerCallbackQuery(callbackQueryId, plan.text);
    return true;
  }
  if (plan.kind === "update-menu") {
    await deps.updateModelMenuMessage();
    await deps.answerCallbackQuery(callbackQueryId, plan.text);
    return true;
  }
  if (plan.kind === "refresh-status") {
    if (plan.shouldApplyThinkingLevel && plan.selection.thinkingLevel) {
      deps.setThinkingLevel(plan.selection.thinkingLevel);
    }
    await deps.updateStatusMessage();
    await deps.answerCallbackQuery(callbackQueryId, plan.callbackText);
    return true;
  }
  const changed = await deps.setModel(plan.selection.model);
  if (changed === false) {
    await deps.answerCallbackQuery(callbackQueryId, "Model is not available.");
    return true;
  }
  deps.setCurrentModel(plan.selection.model);
  if (plan.selection.thinkingLevel) {
    deps.setThinkingLevel(plan.selection.thinkingLevel);
  }
  await deps.updateStatusMessage();
  if (plan.mode === "restart-after-tool") {
    deps.stagePendingModelSwitch(plan.selection);
    await deps.answerCallbackQuery(callbackQueryId, plan.callbackText);
    return true;
  }
  if (plan.mode === "restart-now") {
    const restarted = await deps.restartInterruptedTelegramTurn(plan.selection);
    if (!restarted) {
      await deps.answerCallbackQuery(
        callbackQueryId,
        "Pi is busy. Send /stop first.",
      );
      return true;
    }
  }
  await deps.answerCallbackQuery(callbackQueryId, plan.callbackText);
  return true;
}

export async function handleTelegramStatusMenuCallbackAction(
  callbackQueryId: string,
  data: string | undefined,
  activeModel: Model<any> | undefined,
  deps: TelegramStatusMenuCallbackDeps,
): Promise<boolean> {
  const action = parseTelegramMenuCallbackAction(data);
  if (action.kind === "status" && action.action === "model") {
    await deps.updateModelMenuMessage();
    await deps.answerCallbackQuery(callbackQueryId);
    return true;
  }
  if (!(action.kind === "status" && action.action === "thinking")) {
    return false;
  }
  if (!activeModel?.reasoning) {
    await deps.answerCallbackQuery(
      callbackQueryId,
      "This model has no reasoning controls.",
    );
    return true;
  }
  await deps.updateThinkingMenuMessage();
  await deps.answerCallbackQuery(callbackQueryId);
  return true;
}

export async function handleTelegramThinkingMenuCallbackAction(
  callbackQueryId: string,
  data: string | undefined,
  activeModel: Model<any> | undefined,
  deps: TelegramThinkingMenuCallbackDeps,
): Promise<boolean> {
  const action = parseTelegramMenuCallbackAction(data);
  if (action.kind !== "thinking:set") return false;
  if (!isThinkingLevel(action.level)) {
    await deps.answerCallbackQuery(callbackQueryId, "Invalid thinking level.");
    return true;
  }
  if (!activeModel?.reasoning) {
    await deps.answerCallbackQuery(
      callbackQueryId,
      "This model has no reasoning controls.",
    );
    return true;
  }
  deps.setThinkingLevel(action.level);
  await deps.updateStatusMessage();
  await deps.answerCallbackQuery(
    callbackQueryId,
    `Thinking: ${deps.getCurrentThinkingLevel()}`,
  );
  return true;
}

export function buildThinkingMenuText(
  activeModel: Model<any> | undefined,
  currentThinkingLevel: ThinkingLevel,
): string {
  const lines = ["Choose a thinking level"];
  if (activeModel) {
    lines.push(`Model: ${getCanonicalModelId(activeModel)}`);
  }
  lines.push(`Current: ${currentThinkingLevel}`);
  return lines.join("\n");
}

export function getTelegramModelMenuPage(
  state: TelegramModelMenuState,
  pageSize: number,
): TelegramModelMenuPage {
  const items = getModelMenuItems(state);
  const pageCount = Math.max(1, Math.ceil(items.length / pageSize));
  const page = Math.max(0, Math.min(state.page, pageCount - 1));
  const start = page * pageSize;
  return {
    page,
    pageCount,
    start,
    items: items.slice(start, start + pageSize),
  };
}

export function buildModelMenuReplyMarkup(
  state: TelegramModelMenuState,
  currentModel: Model<any> | undefined,
  pageSize: number,
): TelegramReplyMarkup {
  const menuPage = getTelegramModelMenuPage(state, pageSize);
  const rows = menuPage.items.map((entry, index) => [
    {
      text: formatScopedModelButtonText(entry, currentModel),
      callback_data: `model:pick:${menuPage.start + index}`,
    },
  ]);
  if (menuPage.pageCount > 1) {
    const previousPage =
      menuPage.page === 0 ? menuPage.pageCount - 1 : menuPage.page - 1;
    const nextPage =
      menuPage.page === menuPage.pageCount - 1 ? 0 : menuPage.page + 1;
    rows.push([
      { text: "⬅️", callback_data: `model:page:${previousPage}` },
      {
        text: `${menuPage.page + 1}/${menuPage.pageCount}`,
        callback_data: "model:noop",
      },
      { text: "➡️", callback_data: `model:page:${nextPage}` },
    ]);
  }
  if (state.scopedModels.length > 0) {
    rows.push([
      {
        text: state.scope === "scoped" ? "✅ Scoped" : "Scoped",
        callback_data: "model:scope:scoped",
      },
      {
        text: state.scope === "all" ? "✅ All" : "All",
        callback_data: "model:scope:all",
      },
    ]);
  }
  return { inline_keyboard: rows };
}

export function buildThinkingMenuReplyMarkup(
  currentThinkingLevel: ThinkingLevel,
): TelegramReplyMarkup {
  return {
    inline_keyboard: THINKING_LEVELS.map((level) => [
      {
        text: level === currentThinkingLevel ? `✅ ${level}` : level,
        callback_data: `thinking:set:${level}`,
      },
    ]),
  };
}

export function buildStatusReplyMarkup(
  activeModel: Model<any> | undefined,
  currentThinkingLevel: ThinkingLevel,
): TelegramReplyMarkup {
  const rows: Array<Array<{ text: string; callback_data: string }>> = [];
  rows.push([
    {
      text: formatStatusButtonLabel(
        "Model",
        activeModel ? getCanonicalModelId(activeModel) : "unknown",
      ),
      callback_data: "status:model",
    },
  ]);
  if (activeModel?.reasoning) {
    rows.push([
      {
        text: formatStatusButtonLabel("Thinking", currentThinkingLevel),
        callback_data: "status:thinking",
      },
    ]);
  }
  return { inline_keyboard: rows };
}

export function buildTelegramModelMenuRenderPayload(
  state: TelegramModelMenuState,
  activeModel: Model<any> | undefined,
): TelegramMenuRenderPayload {
  return {
    nextMode: "model",
    text: MODEL_MENU_TITLE,
    mode: "html",
    replyMarkup: buildModelMenuReplyMarkup(
      state,
      activeModel,
      TELEGRAM_MODEL_PAGE_SIZE,
    ),
  };
}

export function buildTelegramThinkingMenuRenderPayload(
  activeModel: Model<any> | undefined,
  currentThinkingLevel: ThinkingLevel,
): TelegramMenuRenderPayload {
  return {
    nextMode: "thinking",
    text: buildThinkingMenuText(activeModel, currentThinkingLevel),
    mode: "plain",
    replyMarkup: buildThinkingMenuReplyMarkup(currentThinkingLevel),
  };
}

export function buildTelegramStatusMenuRenderPayload(
  statusText: string,
  activeModel: Model<any> | undefined,
  currentThinkingLevel: ThinkingLevel,
): TelegramMenuRenderPayload {
  return {
    nextMode: "status",
    text: statusText,
    mode: "html",
    replyMarkup: buildStatusReplyMarkup(activeModel, currentThinkingLevel),
  };
}

export async function updateTelegramModelMenuMessage(
  state: TelegramModelMenuState,
  activeModel: Model<any> | undefined,
  deps: TelegramMenuMessageRuntimeDeps,
): Promise<void> {
  const payload = buildTelegramModelMenuRenderPayload(state, activeModel);
  state.mode = payload.nextMode;
  await deps.editInteractiveMessage(
    state.chatId,
    state.messageId,
    payload.text,
    payload.mode,
    payload.replyMarkup,
  );
}

export async function updateTelegramThinkingMenuMessage(
  state: TelegramModelMenuState,
  activeModel: Model<any> | undefined,
  currentThinkingLevel: ThinkingLevel,
  deps: TelegramMenuMessageRuntimeDeps,
): Promise<void> {
  const payload = buildTelegramThinkingMenuRenderPayload(
    activeModel,
    currentThinkingLevel,
  );
  state.mode = payload.nextMode;
  await deps.editInteractiveMessage(
    state.chatId,
    state.messageId,
    payload.text,
    payload.mode,
    payload.replyMarkup,
  );
}

export async function updateTelegramStatusMessage(
  state: TelegramModelMenuState,
  statusText: string,
  activeModel: Model<any> | undefined,
  currentThinkingLevel: ThinkingLevel,
  deps: TelegramMenuMessageRuntimeDeps,
): Promise<void> {
  const payload = buildTelegramStatusMenuRenderPayload(
    statusText,
    activeModel,
    currentThinkingLevel,
  );
  state.mode = payload.nextMode;
  await deps.editInteractiveMessage(
    state.chatId,
    state.messageId,
    payload.text,
    payload.mode,
    payload.replyMarkup,
  );
}

export async function sendTelegramStatusMessage(
  state: TelegramModelMenuState,
  statusText: string,
  activeModel: Model<any> | undefined,
  currentThinkingLevel: ThinkingLevel,
  deps: TelegramMenuMessageRuntimeDeps,
): Promise<number | undefined> {
  const payload = buildTelegramStatusMenuRenderPayload(
    statusText,
    activeModel,
    currentThinkingLevel,
  );
  state.mode = payload.nextMode;
  return deps.sendInteractiveMessage(
    state.chatId,
    payload.text,
    payload.mode,
    payload.replyMarkup,
  );
}

export async function sendTelegramModelMenuMessage(
  state: TelegramModelMenuState,
  activeModel: Model<any> | undefined,
  deps: TelegramMenuMessageRuntimeDeps,
): Promise<number | undefined> {
  const payload = buildTelegramModelMenuRenderPayload(state, activeModel);
  state.mode = payload.nextMode;
  return deps.sendInteractiveMessage(
    state.chatId,
    payload.text,
    payload.mode,
    payload.replyMarkup,
  );
}
