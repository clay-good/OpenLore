# Wire the global `--config` path: an explicit config location is actually honored

> Status: SHIPPED (2026-07-18). Follow-up to `fix-cli-output-hygiene` (stacked on that branch),
> which made an unreadable explicit `--config` fatal but left the deeper defect open: the global
> `--config <path>` option was otherwise **inert**. Now honored via a single resolver
> `resolveOpenLoreConfigPath` + a process-scoped, primary-root-keyed override in `config-manager.ts`;
> `readOpenLoreConfig`/`writeOpenLoreConfig`/`openloreConfigExists` and the two direct readers
> (`doctor.ts`, `cold-start-bootstrap.ts`) route through it, and `index.ts` sets the override in
> preAction when `--config` is CLI-sourced and readable. `doctor`'s config check additionally now
> names the path it actually read (relative for the default, the real path when redirected) instead
> of a hardcoded `.openlore/config.json`. Default behavior is byte-identical; peer/federation reads
> are provably untouched (keyed to the resolved primary root).

## The gap

`--config <path>` is a documented global option (`src/cli/index.ts`), but nothing consumes its
value. Config reads flow through `readOpenLoreConfig(rootPath)` (~45 call sites) and two direct
readers (`doctor.ts`, `cold-start-bootstrap.ts`), all of which hard-code
`<rootPath>/.openlore/config.json`. Result today:

- `openlore --config /team/shared.json enforce` → reads `.openlore/config.json` (or nothing), NOT
  the shared policy the user named. Silent. `fix-cli-output-hygiene` only catches the *missing-file*
  case; a *readable* wrong-path file is still ignored.

## What changes

One override, resolved in one place, keyed to the primary root so peer/federation reads are never
touched:

1. `config-manager.ts` gains `resolveOpenLoreConfigPath(rootPath)` — the single source of truth for
   "where is this root's config file". It returns a process-scoped override **only when the override's
   root matches the resolved `rootPath`**; otherwise the default `<rootPath>/.openlore/config.json`.
   `readOpenLoreConfig` / `writeOpenLoreConfig` / `openloreConfigExists` all route through it, as do
   the two direct readers (`doctor.ts`, `cold-start-bootstrap.ts`).
2. `setPrimaryConfigPath(rootPath, configPath)` / `clearPrimaryConfigPath()` register/clear the
   override (resolved paths).
3. `index.ts` preAction: when `--config` came from the CLI (commander `getOptionValueSource`) and is
   readable (the existing `fix-cli-output-hygiene` guard already fails the unreadable case),
   `setPrimaryConfigPath(resolve(cwd), resolve(configPath))`.

Scope guardrails:

- Only the **config file** is redirected. The `.openlore/` artifact dir (index, analysis, vector
  store) is unchanged — `--config` is "path to config file", not "relocate everything".
- The override is keyed to `resolve(primaryRoot)`. Federation / spec-store reads of *peer* repos use
  different absolute paths and so are never redirected — the flag governs only the current project's
  config, exactly as scoped.
- Default behavior is byte-identical: with no explicit `--config`, commander's source is `default`,
  the override is never set, every path resolves as before.

## Why this is in scope

`fix-cli-output-hygiene` shipped fatal-on-missing and named this as the deliberately-deferred
remainder ("fully redirecting every `readOpenLoreConfig` call site … stays out of scope"). This is
that remainder: a decorative flag becomes an honest one, with the federation-safety and
default-unchanged guarantees a blanket global would not give.

## Impact

- `config-manager.ts` (override + resolver), `doctor.ts` + `cold-start-bootstrap.ts` (route through
  the resolver), `index.ts` (set the override in preAction). Regression tests per behavior.
- Specs: `cli` — 1 ADDED requirement (ExplicitConfigPathIsHonored).
- Risk: low. Opt-in by an explicit flag; default path unchanged; peer reads provably untouched.
