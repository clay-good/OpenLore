# Brief a prompt only on code it names exactly

## Why

The prompt-submitted hook is the one OpenLore output every agent turn receives unasked. An audit
on 2026-11-15 replayed real prompts from this repository's Claude Code sessions and compared each
briefing with the files the agent then read or edited (deterministic, no LLM judge):

| | Before | After this change |
|---|---|---|
| Logged sessions: briefings on code prompts naming a file the agent touched | 5 of 117 (4%) | — |
| Replay of 68 real code prompts (current build): briefings | 25 | 2 |
| … naming a file the agent touched | 6 (24%) | 2 (100%) |
| Mean precision of named files | 4% | 100% |
| Mean briefing size | 2,063 chars | about 500 chars |
| Per-turn pointer lines ("No briefing: …") | on most turns | none; one line per session |

Real prompts are about process and intent ("fix ci on 708", "start group 2", "resolve conflicts on
714") and name no code. A keyword search over such text returns broad hubs (`index.ts`,
`spec-workflow.ts` were in most briefings). An agent that is shown wrong code on most turns learns
to ignore the channel, and the per-turn pointer lines cost context on every turn for no gain.

## What Changes

- The prompt is searched only for **anchors**: `backticked` names, file paths, and
  identifier-shaped words (camelCase, two-hump PascalCase, snake_case, CONSTANT_CASE,
  `Class.method(`). Prose alone is never searched. Text inside `<pasted_content>` is material the
  user brought, not their request: it sets neither anchors nor the OpenSpec proposal workflow.
- The briefing keeps only what the anchors name **exactly** (a function whose name or last
  `Class.` segment equals an anchor, or a file an anchored path names). Search neighbours, spec
  domains and house style are dropped. Fixture and example files are shown only for a path anchor
  into them. A name defined in more than two files is ambiguous and is not an anchor.
- The repository-wide parse-health sentence is left out of the prompt briefing (it qualifies a
  search, and this briefing makes no absence claim); a per-file note stays when it names a shown file.
- Every withheld turn is silent, except a missing index (stated once per session, as before). What
  silence means is stated once per session: "Prompts are briefed only when they name code that
  resolves exactly in the index …".
- New withhold reason `no-anchor` (telemetry and debug output).

Unchanged: the off switches, runtime limit, fail-open behavior, the harness-notice and
management-intent gates, and `orient` itself. Pi's `before_agent_start` injection is a separate
path and is not changed here.
