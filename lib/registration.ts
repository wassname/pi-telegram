/**
 * Telegram extension registration helpers
 * Owns tool, command, and lifecycle-hook registration so index.ts can stay focused on runtime orchestration state and side effects
 */

import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  SlashCommandInfo,
} from "@mariozechner/pi-coding-agent";

import { queueTelegramAttachments } from "./attachments.ts";
import type { PendingTelegramTurn } from "./queue.ts";

function buildAttachmentParametersSchema(maxAttachmentsPerTurn: number) {
  return {
    type: "object",
    properties: {
      paths: {
        type: "array",
        items: {
          type: "string",
          description: "Local file path to attach",
        },
        minItems: 1,
        maxItems: maxAttachmentsPerTurn,
      },
    },
    required: ["paths"],
  };
}

// --- Tool Registration ---

export interface TelegramAttachmentToolRegistrationDeps {
  maxAttachmentsPerTurn: number;
  getActiveTurn: () => PendingTelegramTurn | undefined;
  statPath: (path: string) => Promise<{ isFile(): boolean }>;
}

export function registerTelegramAttachmentTool(
  pi: ExtensionAPI,
  deps: TelegramAttachmentToolRegistrationDeps,
): void {
  pi.registerTool({
    name: "telegram_attach",
    label: "Telegram Attach",
    description:
      "Queue one or more local files to be sent with the next Telegram reply.",
    promptSnippet: "Queue local files to be sent with the next Telegram reply.",
    promptGuidelines: [
      "When handling a [telegram] message and the user asked for a file or generated artifact, call telegram_attach with the local path instead of only mentioning the path in text.",
    ],
    parameters: buildAttachmentParametersSchema(deps.maxAttachmentsPerTurn),
    async execute(_toolCallId, params) {
      return queueTelegramAttachments({
        activeTurn: deps.getActiveTurn(),
        paths: params.paths,
        maxAttachmentsPerTurn: deps.maxAttachmentsPerTurn,
        statPath: deps.statPath,
      });
    },
  });
}

// --- Command Registration ---

export interface TelegramBotCommand {
  command: string;
  description: string;
}

export const TELEGRAM_BOT_COMMAND_LIMIT = 100;

// Telegram requires command names to match ^[a-z0-9_]{1,32}$ (no dashes).
// Pi commands frequently use dashes (e.g. "compact-now"), so we transform
// dash -> underscore for the Telegram-facing name and reverse it on the way
// back so the harness still receives its original name.
const telegramCommandNamePattern = /^[a-z0-9_]{1,32}$/;

export function toTelegramCommandName(name: string): string {
  return name.replace(/-/g, "_");
}

export function fromTelegramCommandName(
  telegramName: string,
  piCommandNames: ReadonlySet<string>,
): string {
  if (piCommandNames.has(telegramName)) return telegramName;
  const dashed = telegramName.replace(/_/g, "-");
  if (piCommandNames.has(dashed)) return dashed;
  return telegramName;
}

const bridgeLocalBotCommands: TelegramBotCommand[] = [
  { command: "start", description: "Show help and refresh this menu" },
  { command: "help", description: "Show help" },
  { command: "status", description: "Show model, usage, cost, and context status" },
  { command: "trace", description: "Cycle display mode: text / compact / full" },
  { command: "model", description: "Open the interactive model selector" },
  { command: "compact", description: "Compact the current pi session" },
  { command: "stop", description: "Abort the current pi task" },
  { command: "quit", description: "Stop the Telegram bridge in this session" },
  { command: "exit", description: "Stop the Telegram bridge in this session" },
];

export function buildTelegramBotCommands(
  piCommands: Pick<SlashCommandInfo, "name" | "description">[],
): TelegramBotCommand[] {
  const commands: TelegramBotCommand[] = [];
  const names = new Set<string>();
  const addCommand = (command: TelegramBotCommand) => {
    if (names.has(command.command)) return;
    if (!telegramCommandNamePattern.test(command.command)) return;
    names.add(command.command);
    commands.push(command);
  };

  for (const command of bridgeLocalBotCommands) {
    addCommand(command);
  }
  for (const command of piCommands) {
    addCommand({
      command: toTelegramCommandName(command.name),
      description: command.description ?? command.name,
    });
  }

  return commands.slice(0, TELEGRAM_BOT_COMMAND_LIMIT);
}

export interface TelegramCommandRegistrationDeps {
  promptForConfig: (ctx: ExtensionCommandContext) => Promise<void>;
  getStatusLines: () => string[];
  reloadConfig: () => Promise<void>;
  hasBotToken: () => boolean;
  startPolling: (ctx: ExtensionCommandContext) => Promise<void>;
  stopPolling: () => Promise<void>;
  updateStatus: (ctx: ExtensionCommandContext) => void;
}

export function registerTelegramCommands(
  pi: ExtensionAPI,
  deps: TelegramCommandRegistrationDeps,
): void {
  pi.registerCommand("telegram-setup", {
    description: "Configure Telegram bot token",
    handler: async (_args, ctx) => {
      await deps.promptForConfig(ctx);
    },
  });
  pi.registerCommand("telegram-status", {
    description: "Show Telegram bridge status",
    handler: async (_args, ctx) => {
      ctx.ui.notify(deps.getStatusLines().join(" | "), "info");
    },
  });
  pi.registerCommand("telegram-connect", {
    description: "Start the Telegram bridge in this pi session",
    handler: async (_args, ctx) => {
      await deps.reloadConfig();
      if (!deps.hasBotToken()) {
        await deps.promptForConfig(ctx);
        return;
      }
      await deps.startPolling(ctx);
      deps.updateStatus(ctx);
    },
  });
  pi.registerCommand("telegram-disconnect", {
    description: "Stop the Telegram bridge in this pi session",
    handler: async (_args, ctx) => {
      await deps.stopPolling();
      deps.updateStatus(ctx);
    },
  });
}

// --- Lifecycle Hook Registration ---

export interface TelegramLifecycleRegistrationDeps {
  onSessionStart: (event: unknown, ctx: ExtensionContext) => Promise<void>;
  onSessionShutdown: (event: unknown, ctx: ExtensionContext) => Promise<void>;
  onBeforeAgentStart: (
    event: unknown,
    ctx: ExtensionContext,
  ) => Promise<unknown> | unknown;
  onModelSelect: (
    event: unknown,
    ctx: ExtensionContext,
  ) => Promise<void> | void;
  onAgentStart: (event: unknown, ctx: ExtensionContext) => Promise<void>;
  onToolExecutionStart: (
    event: unknown,
    ctx: ExtensionContext,
  ) => Promise<void> | void;
  onToolExecutionEnd: (
    event: unknown,
    ctx: ExtensionContext,
  ) => Promise<void> | void;
  onMessageStart: (event: unknown, ctx: ExtensionContext) => Promise<void>;
  onMessageUpdate: (event: unknown, ctx: ExtensionContext) => Promise<void>;
  onAgentEnd: (event: unknown, ctx: ExtensionContext) => Promise<void>;
}

export function registerTelegramLifecycleHooks(
  pi: ExtensionAPI,
  deps: TelegramLifecycleRegistrationDeps,
): void {
  pi.on("session_start", async (event, ctx) => {
    await deps.onSessionStart(event, ctx);
  });
  pi.on("session_shutdown", async (event, ctx) => {
    await deps.onSessionShutdown(event, ctx);
  });
  pi.on("before_agent_start", (async (event: unknown, ctx: ExtensionContext) =>
    deps.onBeforeAgentStart(event, ctx)) as never);
  pi.on("model_select", async (event, ctx) => {
    await deps.onModelSelect(event, ctx);
  });
  pi.on("agent_start", async (event, ctx) => {
    await deps.onAgentStart(event, ctx);
  });
  pi.on("tool_execution_start", async (event, ctx) => {
    await deps.onToolExecutionStart(event, ctx);
  });
  pi.on("tool_execution_end", async (event, ctx) => {
    await deps.onToolExecutionEnd(event, ctx);
  });
  pi.on("message_start", async (event, ctx) => {
    await deps.onMessageStart(event, ctx);
  });
  pi.on("message_update", async (event, ctx) => {
    await deps.onMessageUpdate(event, ctx);
  });
  pi.on("agent_end", async (event, ctx) => {
    await deps.onAgentEnd(event, ctx);
  });
}
