# Measure whether pushed evidence is used

> Priority: P1 · Not built
> Reaches the agent through: no change to what the agent sees; the owner reads `openlore status`
> Why it helps the agent: kinds of evidence the agent never uses get cut or fixed, so what stays in its context is worth reading.

## Problem

OpenLore pushes evidence at several moments: the prompt briefing, ledger facts after an edit, the
before-stop receipt, and (with the open changes) the first-touch briefing and the session catch-up.
We measure precision once, offline (`npm run bench:briefing`), and we count findings fixed or
decided (`openlore status`, `hookOutcomes`). We do not know, from daily use, which kinds of pushed
lines the agent acts on and which it ignores. So we cannot tell a line that helps from a line that
costs context. ROADMAP says "proof from daily use"; this is that proof.

## What changes

- **Record each pushed line.** When a hook prints a line, the per-session record
  (`src/core/services/hook-session.ts`) stores its moment, its kind (from a closed list, for
  example `caller-count`, `decision`, `asserting-tests`, `catch-up-hub`), and the files, symbols,
  and test paths it names. Never the line's text.
- **Mark it used.** Later in the same session, a line is used when the agent reads or edits a file
  it names, runs a `Bash` command whose text holds a test path it names, or calls an OpenLore tool
  on a symbol it names (the ledger's served set). The moments that see these events already run;
  they only update the record.
- **Report yield.** `openlore status` prints one line per moment and kind over the sessions kept
  (7 days): pushed, used, and the share used. `--json` carries the same numbers.
- **Name cut candidates.** A kind pushed 20 times or more with no use in the window is named in
  one status line as a candidate to cut or fix. Nothing is turned off automatically.

## What does not change

- The agent sees the same output. No new tool, command, flag, or config key.
- The records stay in `.openlore/` and are never sent anywhere (as today's hook-health records).
- Local only, no LLM, no spec framework needed.

## Limits we disclose

- "Used" is a proxy. An agent can act on a line by deciding not to edit, which leaves no trace, and
  it can open a named file for another reason. The status line says "followed by use", not "helped".
- A fact named in a line that the agent already knew counts as used if it touches the file. Yield
  is an upper bound on value, and a zero is the strong signal.
- Only Claude Code sessions with a `session_id` are measured. Pi and Codex are counted when their
  hooks send one.

## Depends on

Shipped: the per-session record, hook-health in `openlore status`, the session ledger's served set.
It measures `add-first-touch-file-briefing` and `add-session-catch-up-briefing` when they ship.
