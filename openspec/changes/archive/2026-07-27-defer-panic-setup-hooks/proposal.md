# Panic setup hooks — `setup --hooks` / `--panic` (deferred follow-up from PR #83)

> **UPDATE (2026-06-21): BUILT in PR #175** — `setup --hooks` / `--panic` are implemented as opt-in
> flags (never installed by a default `setup`; reconciled with `--global`, no `installClaudeHook`
> dependency). History below.
>
> Status: BUILT (PR #175, merged; see the UPDATE banner above). Status line corrected 2026-06-25 — was a stale "DEFERRED". History: the `setup` wiring was left as upstream `main` in PR #175 (zero-conflict,
> zero-risk). Preserves @laurentftech's hook-installer design (PR #83). Build after the core is
> validated and (for the gryph-watch hook) after Gryph lands.

## Why it was deferred

Auto-installing agent hooks changes OpenLore's default install footprint — it writes PreToolUse and
UserPromptSubmit entries into `.claude/settings.json`. That should not happen until the behavior those
hooks drive is validated. Deferring it also cleanly sidestepped a compile break: PR #83's `setup.ts`
imported `installClaudeHook`, a symbol current `main` has since removed.

Until this lands, users opt in by setting `panicResponse.mode` directly in `.openlore/config.json`
(default `off`), and wire `openlore panic-check` as a PreToolUse hook by hand if they want it.

## What it restores (Laurent's design, intact)

- `installPanicCheckHook(rootPath, format)` — adds an `openlore panic-check` PreToolUse hook
  (claude | kilo | codex), idempotent via a marker check.
- `installGryphWatchHook(rootPath)` — adds an `openlore gryph-watch` UserPromptSubmit hook
  (depends on `defer-gryph-runtime-observability`).
- `setup --hooks <format>` and `setup --panic <mode>` flags, both non-interactive, reconciled with the
  current `setup` command (which added `--global` since PR #83).

Recoverable from PR #83 (`feat/panic-response-layer`, `setup.ts`).

## Gate

- The PreToolUse `panic-check` hook installer: after the observe-mode accuracy gate
  (`adopt-agent-behavioral-governance`).
- The UserPromptSubmit `gryph-watch` hook installer: also blocked on `defer-gryph-runtime-observability`.

## Out of scope

- Installing any hook by default. `setup --hooks` stays an explicit, opt-in flag.
