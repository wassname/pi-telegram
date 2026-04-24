# Stop Recovery And Trace Visibility

## Goal
Fix two Telegram bridge failures: `/stop` must not leave the bridge permanently wedged, and truncated shell or trace output must be visibly marked while full trace mode keeps complete detail.

## Scope
In: abort-recovery behavior for stale Telegram-owned turns, direct `!` shell reply delivery, compact trace truncation signaling, focused regression coverage, and synced user-facing docs.
Out: broader queue-policy redesign, non-Telegram pi abort semantics, and new trace UI beyond the existing `/trace` mode cycle.

## Requirements
- R1: A stale aborted Telegram turn cannot block later Telegram prompts forever. Done means: when local Telegram turn state survives after pi is already idle, the next Telegram message recovers the bridge and normal prompt dispatch resumes. VERIFY: targeted runtime regression shows `/stop`, no `agent_end`, then a later Telegram prompt dispatches into pi. If it silently failed, the test would still be stuck waiting for another dispatch.
- R2: Direct `!` shell replies do not silently crop output. Done means: long stdout/stderr are delivered through chunked markdown replies instead of a hidden `slice(0, 3900)`. VERIFY: targeted regression inspects the emitted shell reply text and confirms the tail of long output is still present.
- R3: Any compact trace truncation is explicit, and full trace mode stays untruncated. Done means: compact thinking/tool blocks include a visible “use /trace for full” notice when shortened, while full-mode tests still see the complete content. VERIFY: rendering tests assert the truncation notice in compact mode and the original long text in full mode.
- R4: User-facing docs describe the actual `/trace` behavior and the new recovery/truncation guarantees. Done means: README, architecture doc, and changelog all reflect the shipped behavior. VERIFY: grep/read shows aligned wording in all three docs.

## Tasks
- [x] T1 (R1): Add stale-abort recovery in the Telegram runtime.
  - steps: track local abort requests, detect stale Telegram abort state when pi is idle, clear stale local state, and resume normal dispatch.
  - verify: `node --experimental-strip-types --test tests/queue.test.ts`
  - success: the new stop-recovery regression passes.
  - likely_fail: local active-turn state is never cleared, so the test times out waiting for the resumed dispatch.
  - sneaky_fail: recovery clears state too broadly and breaks normal abort completion; existing queue tests would fail around aborted-turn history or model-switch abort behavior.
  - UAT: "when Telegram gets stuck after `/stop`, my next normal message is processed again instead of being ignored forever."
- [x] T2 (R2, R3): Remove hidden cropping and make compact truncation explicit.
  - steps: route direct shell replies through markdown chunking, replace silent compact truncation with explicit notices, and mark preview truncation clearly when it happens.
  - verify: `node --experimental-strip-types --test tests/rendering.test.ts tests/replies.test.ts tests/queue.test.ts`
  - success: new rendering/reply/runtime assertions pass.
  - likely_fail: shell output is still sliced or compact traces still only show a bare ellipsis.
  - sneaky_fail: full-mode trace content gets truncated by the new helpers; full-mode assertions catch that.
  - UAT: "when a tool call or shell command is shortened in compact mode, Telegram explicitly tells me it was truncated and that `/trace` full mode shows the complete content."
- [x] T3 (R4): Sync docs for the shipped behavior.
  - steps: update README, architecture doc, and changelog wording for `/trace`, stale-abort recovery, and explicit truncation markers.
  - verify: `rg -n "trace|stop|trunc" README.md docs/architecture.md CHANGELOG.md`
  - success: aligned wording appears in all files.
  - likely_fail: runtime changes land without doc updates, so the grep output is missing one of the files.
  - sneaky_fail: docs still describe `/trace` as a simple on/off toggle instead of text/compact/full.
  - UAT: "when I read the docs, they match what the Telegram bot actually does."

## Context
- The bridge keeps local queue and active-turn state separate from pi core state, so stale local state can wedge Telegram even when pi is already idle.
- `!` shell commands bypass the queue and are handled directly in `index.ts`.
- `renderBlockMessage()` controls compact/full trace formatting for thinking, tool calls, and tool results.

## Log
- Existing tests cover abort-plus-follow-up history, but they did not cover the stale-local-state path where pi is already idle and Telegram still thinks a turn is active.
- The immediate `/stop` failure had a concrete routing bug too: slash commands were passed into `handleTelegramCommand()` with the wrong argument positions, so Telegram local commands could receive the wrong message/ctx objects while direct `!` shell commands still worked.

## TODO
- Consider exposing a clearer inline status indicator when the bridge auto-recovers a stale aborted turn.

## Errors
| Task | Error | Resolution |
|------|-------|------------|
