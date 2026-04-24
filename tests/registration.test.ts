/**
 * Regression tests for the Telegram registration domain
 * Covers tool registration and command registration behavior without exercising the full extension runtime
 */

import assert from "node:assert/strict";
import test from "node:test";

import telegramExtension from "../index.ts";
import {
  buildTelegramBotCommands,
  registerTelegramAttachmentTool,
  registerTelegramCommands,
  registerTelegramLifecycleHooks,
  TELEGRAM_BOT_COMMAND_LIMIT,
} from "../lib/registration.ts";

function createRegistrationApiHarness() {
  let tool: any;
  const commands = new Map<string, any>();
  const handlers = new Map<string, any>();
  return {
    tool: () => tool,
    commands,
    handlers,
    api: {
      on: (event: string, handler: unknown) => {
        handlers.set(event, handler);
      },
      registerTool: (definition: unknown) => {
        tool = definition;
      },
      registerCommand: (name: string, definition: unknown) => {
        commands.set(name, definition);
      },
    } as never,
  };
}

test("Registration registers the attachment tool and delegates queueing", async () => {
  const harness = createRegistrationApiHarness();
  const activeTurn = {
    queuedAttachments: [],
  } as unknown as {
    queuedAttachments: Array<{ path: string; fileName: string }>;
  } & ReturnType<
    Parameters<typeof registerTelegramAttachmentTool>[1]["getActiveTurn"]
  >;
  registerTelegramAttachmentTool(harness.api, {
    maxAttachmentsPerTurn: 2,
    getActiveTurn: () => activeTurn,
    statPath: async () => ({ isFile: () => true }),
  });
  const tool = harness.tool();
  assert.equal(tool?.name, "telegram_attach");
  const result = await tool.execute("tool-call", { paths: ["/tmp/report.md"] });
  assert.deepEqual(activeTurn.queuedAttachments, [
    { path: "/tmp/report.md", fileName: "report.md" },
  ]);
  assert.deepEqual(result.details.paths, ["/tmp/report.md"]);
});

test("Registration commands expose setup and status behaviors", async () => {
  const harness = createRegistrationApiHarness();
  const events: string[] = [];
  registerTelegramCommands(harness.api, {
    promptForConfig: async () => {
      events.push("setup");
    },
    getStatusLines: () => ["bot: @demo", "polling: stopped"],
    reloadConfig: async () => {
      events.push("reload");
    },
    hasBotToken: () => false,
    startPolling: async () => {
      events.push("start");
    },
    stopPolling: async () => {
      events.push("stop");
    },
    updateStatus: () => {
      events.push("update-status");
    },
  });
  const setupCommand = harness.commands.get("telegram-setup");
  const statusCommand = harness.commands.get("telegram-status");
  const notifications: string[] = [];
  const ctx = {
    ui: {
      notify: (message: string) => {
        notifications.push(message);
      },
    },
  } as never;
  await setupCommand.handler("", ctx);
  await statusCommand.handler("", ctx);
  assert.deepEqual(events, ["setup"]);
  assert.deepEqual(notifications, ["bot: @demo | polling: stopped"]);
});

test("Registration connect and disconnect commands reload config and control polling", async () => {
  const harness = createRegistrationApiHarness();
  const events: string[] = [];
  let hasToken = false;
  registerTelegramCommands(harness.api, {
    promptForConfig: async () => {
      events.push("setup");
    },
    getStatusLines: () => [],
    reloadConfig: async () => {
      events.push("reload");
    },
    hasBotToken: () => hasToken,
    startPolling: async () => {
      events.push("start");
    },
    stopPolling: async () => {
      events.push("stop");
    },
    updateStatus: () => {
      events.push("update-status");
    },
  });
  const connectCommand = harness.commands.get("telegram-connect");
  const disconnectCommand = harness.commands.get("telegram-disconnect");
  const ctx = { ui: { notify: () => {} } } as never;
  await connectCommand.handler("", ctx);
  hasToken = true;
  await connectCommand.handler("", ctx);
  await disconnectCommand.handler("", ctx);
  assert.deepEqual(events, [
    "reload",
    "setup",
    "reload",
    "start",
    "update-status",
    "stop",
    "update-status",
  ]);
});

test("Telegram bot command menu includes valid pi prompt, skill, and extension commands", () => {
  const commands = buildTelegramBotCommands([
    { name: "p", description: "Run prompt template" },
    { name: "skill_cmd", description: "Run skill command" },
    { name: "ext_cmd", description: "Run extension command" },
    { name: "status", description: "Duplicate should not replace local status" },
    { name: "bad-name", description: "Telegram rejects hyphenated names" },
    { name: "review:1", description: "Telegram rejects colon suffixed names" },
    { name: "UPPER", description: "Telegram rejects uppercase names" },
    { name: "x".repeat(33), description: "Telegram rejects long names" },
  ] as never);

  assert.deepEqual(
    commands.map((command) => command.command).slice(0, 12),
    [
      "start",
      "help",
      "status",
      "trace",
      "model",
      "compact",
      "stop",
      "quit",
      "exit",
      "p",
      "skill_cmd",
      "ext_cmd",
    ],
  );
  assert.equal(
    commands.find((command) => command.command === "status")?.description,
    "Show model, usage, cost, and context status",
  );
  assert.equal(commands.some((command) => command.command === "bad-name"), false);
  assert.equal(commands.some((command) => command.command === "review:1"), false);
  assert.equal(commands.some((command) => command.command === "UPPER"), false);
  assert.equal(commands.some((command) => command.command.length > 32), false);
});

test("Telegram bot command menu is capped at the Bot API command limit", () => {
  const piCommands = Array.from({ length: TELEGRAM_BOT_COMMAND_LIMIT + 20 }, (_, index) => ({
    name: `cmd_${index}`,
    description: `Command ${index}`,
  }));
  const commands = buildTelegramBotCommands(piCommands as never);

  assert.equal(commands.length, TELEGRAM_BOT_COMMAND_LIMIT);
  assert.equal(commands.at(0)?.command, "start");
  assert.equal(commands.some((command) => command.command === "cmd_0"), true);
  assert.equal(
    commands.some((command) => command.command === `cmd_${TELEGRAM_BOT_COMMAND_LIMIT}`),
    false,
  );
});

test("Registration lifecycle hooks are registered and delegate to the provided handlers", async () => {
  const harness = createRegistrationApiHarness();
  const events: string[] = [];
  registerTelegramLifecycleHooks(harness.api, {
    onSessionStart: async () => {
      events.push("session-start");
    },
    onSessionShutdown: async () => {
      events.push("session-shutdown");
    },
    onBeforeAgentStart: () => {
      events.push("before-agent-start");
      return { systemPrompt: "prompt" };
    },
    onModelSelect: () => {
      events.push("model-select");
    },
    onAgentStart: async () => {
      events.push("agent-start");
    },
    onToolExecutionStart: () => {
      events.push("tool-start");
    },
    onToolExecutionEnd: () => {
      events.push("tool-end");
    },
    onMessageStart: async () => {
      events.push("message-start");
    },
    onMessageUpdate: async () => {
      events.push("message-update");
    },
    onAgentEnd: async () => {
      events.push("agent-end");
    },
  });
  assert.deepEqual(
    [...harness.handlers.keys()],
    [
      "session_start",
      "session_shutdown",
      "before_agent_start",
      "model_select",
      "agent_start",
      "tool_execution_start",
      "tool_execution_end",
      "message_start",
      "message_update",
      "agent_end",
    ],
  );
  const ctx = {} as never;
  await harness.handlers.get("session_start")({}, ctx);
  await harness.handlers.get("session_shutdown")({}, ctx);
  const beforeAgentStartResult = await harness.handlers.get(
    "before_agent_start",
  )({}, ctx);
  await harness.handlers.get("model_select")({}, ctx);
  await harness.handlers.get("agent_start")({}, ctx);
  await harness.handlers.get("tool_execution_start")({}, ctx);
  await harness.handlers.get("tool_execution_end")({}, ctx);
  await harness.handlers.get("message_start")({}, ctx);
  await harness.handlers.get("message_update")({}, ctx);
  await harness.handlers.get("agent_end")({}, ctx);
  assert.deepEqual(beforeAgentStartResult, { systemPrompt: "prompt" });
  assert.deepEqual(events, [
    "session-start",
    "session-shutdown",
    "before-agent-start",
    "model-select",
    "agent-start",
    "tool-start",
    "tool-end",
    "message-start",
    "message-update",
    "agent-end",
  ]);
});

test("Extension entrypoint wires registration domains into the pi API", () => {
  const harness = createRegistrationApiHarness();
  telegramExtension(harness.api);
  assert.equal(harness.tool()?.name, "telegram_attach");
  assert.deepEqual(
    [...harness.commands.keys()],
    [
      "telegram-setup",
      "telegram-status",
      "telegram-connect",
      "telegram-disconnect",
    ],
  );
  assert.deepEqual(
    [...harness.handlers.keys()],
    [
      "session_start",
      "session_shutdown",
      "before_agent_start",
      "model_select",
      "agent_start",
      "tool_execution_start",
      "tool_execution_end",
      "message_start",
      "message_update",
      "agent_end",
    ],
  );
});

test("Extension before-agent-start hook appends Telegram-specific system prompt guidance", async () => {
  const harness = createRegistrationApiHarness();
  telegramExtension(harness.api);
  const handler = harness.handlers.get("before_agent_start");
  const basePrompt = "System base";
  const telegramResult = await handler(
    { systemPrompt: basePrompt, prompt: "[telegram] hello" },
    {} as never,
  );
  const localResult = await handler(
    { systemPrompt: basePrompt, prompt: "hello" },
    {} as never,
  );
  assert.match(
    telegramResult.systemPrompt,
    /current user message came from Telegram/,
  );
  assert.match(telegramResult.systemPrompt, /telegram_attach/);
  assert.equal(localResult.systemPrompt.includes("came from Telegram"), false);
});
