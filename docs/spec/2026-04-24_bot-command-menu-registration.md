# Telegram Bot Command Menu Registration

## Goal
Make Telegram's bot command menu match the commands that are useful from the DM bridge, including pi prompt and skill commands such as `/p`, not just bridge-local and extension commands.

## Scope
In: bot command menu construction, command registration call, docs, changelog, focused regression tests.
Out: changing Telegram slash-command execution semantics or making Telegram accept command names the Bot API rejects.

## Requirements
- R1: The Telegram bot command menu includes bridge-local commands and every Telegram-valid command returned by `pi.getCommands()`, including `source: "prompt"` and `source: "skill"`. Done means: a test with prompt command `p` produces a `setMyCommands` payload containing `p`. VERIFY: `node --experimental-strip-types --test tests/registration.test.ts`.
- R2: The command menu registration remains Bot API-compatible. Done means: invalid command names are filtered, duplicates are de-duped with bridge-local commands first, and the final list is capped at Telegram's 100-command limit. VERIFY: a pure builder test asserts invalid names and overflow commands are excluded.
- R3: User-facing docs mention that `/start` refreshes the Telegram menu with bridge-local commands plus Telegram-valid pi prompt/skill/extension commands. VERIFY: docs grep shows command-menu behavior in README, architecture, and changelog.

## Tasks
- [x] T1 (R1, R2): Extract/test pure Telegram bot-command menu builder.
  - steps: move local command definitions into a reusable helper, include all valid `pi.getCommands()` entries, de-dupe, cap at 100.
  - verify: `node --experimental-strip-types --test tests/registration.test.ts`.
  - success: test payload includes `p`, `skill_cmd`, excludes invalid `bad-name`/`review:1`, and has length 100.
  - likely_fail: code still filters to extension only; test shows `p` missing.
  - sneaky_fail: registration includes invalid names or too many commands; test checks both.
  - UAT: "when I send `/start`, Telegram's command menu offers `/p` if pi exposes it as a valid command."
- [x] T2 (R3): Update docs and changelog.
  - steps: update README usage/streaming area, architecture controls, changelog current entries.
  - verify: `rg -n "bot command|/start|/p|setMyCommands|prompt" README.md docs/architecture.md CHANGELOG.md`.
  - success: docs mention `/start` refresh and prompt/skill/extension publication.
  - likely_fail: docs only mention local commands; grep misses prompt/skill command menu text.
  - sneaky_fail: docs imply invalid command names can appear; wording says Telegram-valid commands only.

## Context
- Telegram Bot API command names must match lowercase/digit/underscore and max 32 characters.
- Telegram supports at most 100 commands in the bot command menu.
- `pi.getCommands()` returns extension, prompt, and skill commands; built-in interactive commands are not included.
- The bridge handles local commands in Telegram before queueing a pi turn; other slash commands pass through to pi.

## Log
- `pi.getCommands()` docs in `node_modules/@mariozechner/pi-coding-agent/docs/extensions.md` state it includes extension, prompt, and skill commands, but not built-in interactive commands.
- `node --experimental-strip-types --test tests/registration.test.ts`: 8 tests passed, including the `/p`-style command and Bot API cap cases.
- `npm test`: 142 tests passed.
- Docs grep verified `/start` command-menu refresh and prompt/skill/extension publication in README, architecture, changelog, and this spec.

## TODO
- None.

## Errors
| Task | Error | Resolution |
|------|-------|------------|
