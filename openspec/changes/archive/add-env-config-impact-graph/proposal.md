# Environment-variable impact graph: what breaks if I remove or rename this env var

> Status: IMPLEMENTED (2026-06-26, branch `feat/env-config-impact-graph`). `analyze_env_impact` MCP
> tool + `openlore env-impact` CLI + a line-precise read-site extractor (`extractEnvReadSites`) on
> `env-extractor.ts`. Tool count 71 → 72; full-surface payload budget 82_000 → 84_000. `npm run build`
> clean; `vitest run src examples` green (274 files / 5393 tests). Dogfooded e2e on the OpenLore repo
> (see `DOGFOOD-env-config-impact-graph.md`): per-site `required`/`has-fallback` verified against
> source (`?? ''` → soft, bare read → hard); `EMBED_MODEL` traced 3 reads → 57 affected functions / 3
> tests through `resolveEmbedder` into every semantic MCP handler; `OPENLORE_LIVE_LLM` (test-only) and
> `DATABASE_URL` (test-only src reads) correctly resolve to not-found / module-level-only, never a
> false read set. As-built notes: scope is the env inventory's non-test files (a var read only in
> tests is reported not-found, disclosed); read-site→function mapping is line-based (sidesteps the
> byte-vs-UTF-16-offset mismatch a regex `.index` would carry); the not-found candidate list falls
> back to the full inventory when a single-letter typo matches no substring.
>
> Post-merge adversarial-review hardening (same PR, re-dogfooded on a Python/Ruby/Go/TS corpus —
> `DOGFOOD-env-config-impact-graph.md` §D'): (M1) read-site lines come from current source but map to
> cached spans, so when the index is stale the attribution can be wrong / falsely module-level — the
> handler now emits a `staleness` marker + boundary via the git-based `computeStaleness` (reproduced
> and verified); (M2) Python `os.getenv("X")` / `os.environ.get("X")` with no default are now
> `required` (a deferred `None` hard break), symmetric with the TS/Ruby per-site checks; (M3) Ruby
> `ENV.fetch("X") { block }` / `do … end` defaults now resolve to not-required. Wiring audit: complete,
> zero misses.
>
> Net-new conclusion tool — the written backlog (`FEATURE-UPDATES.md`, `STRUCTURAL-CONTEXT-PATTERNS.md`,
> `PARALLEL-WORK-COORDINATION.md`, `HARDEN-DISTRIBUTION-AND-SUBSTRATE.md`) is fully shipped. This is
> the explicitly-earmarked follow-up from `FEATURE-UPDATES.md` ("Deliberately considered and
> deferred"): the *configuration / environment usage graph* — "what breaks if I remove this flag" —
> scoped to environment variables (the deterministic, multi-language subset the substrate already
> extracts), with config-object key reads explicitly deferred and disclosed as out of scope rather
> than guessed. No new dependency, no LLM, no new persisted artifact, no schema migration.

## Why

OpenLore already has an environment-variable **inventory** (`get_env_vars`): the set of env vars a
project declares or reads, with `required` / `hasDefault` flags and the files each appears in. That is
a *list*. It does not answer the question an agent actually asks before touching configuration:

> **"If I remove or rename `DATABASE_URL`, what breaks — which functions read it, and what is the
> blast radius of those reads through the call graph?"**

This is the configuration analogue of the two conclusion tools OpenLore is trusted for:
`analyze_impact` (the blast radius of a *function change*) and `analyze_error_propagation` (the
exceptions that escape a function). All three turn "who/what is affected" from a manual, error-prone
read-every-file exercise into one deterministic answer grounded in the call graph.

The inventory stops at file granularity (`EnvVar.files`). An impact answer needs three things the
inventory does not carry:

1. **Line-precise read sites** — *where* in each file the var is read.
2. **The enclosing function of each read** — so the read can be located in the call graph.
3. **Reverse reachability** from those reading functions — the upstream callers (the blast radius) and
   the tests that transitively reach a reading function (what to run after the change).

Every piece of machinery for (2) and (3) already exists (`FunctionNode` byte/line spans, the
backward-adjacency BFS that `analyze_impact` / `select_tests` use). Only (1) is missing, and it is a
thin, line-precise extension of the regexes `env-extractor.ts` already runs.

## What changes

1. **A line-precise env read-site extractor** (`src/core/analyzer/env-extractor.ts`,
   `extractEnvReadSites`): given a source file's content, relative path, and extension, it reuses the
   *existing* per-language env regexes (TS/JS `process.env.X`, Python `os.environ[...]` /
   `os.environ.get(...)` / `os.getenv(...)`, Go `os.Getenv(...)`, Ruby `ENV[...]` / `ENV.fetch(...)`)
   and returns one record per read **site**: the var name, the 1-based line, and a per-site
   `required` flag (no fallback at this specific site → removing the var hard-breaks here). This is a
   read-site refinement of the existing file-global extraction, not a new detector or new grammar.

2. **A new conclusion tool `analyze_env_impact`** (handler
   `src/core/services/mcp-handlers/env-impact.ts`, CLI `openlore env-impact`): given an env var
   `name`, it
   - resolves the var against the inventory (the cached `env-inventory.json` artifact, or a live
     re-extraction when absent) — an unknown name returns an explicit not-found with near-name
     candidates, never an empty "nothing reads it";
   - re-reads only the files the inventory flags for that var and runs `extractEnvReadSites` to get
     line-precise read sites;
   - maps each read site's line to its **enclosing function** by containment against the cached
     `FunctionNode` line spans (smallest enclosing span wins); a read with no enclosing function is a
     **module-level read**, reported and disclosed (it runs at import time, so its blast radius is
     every importer — a boundary, not a silently-dropped site);
   - computes the **blast radius**: the upstream callers of every reading function (backward BFS over
     the call graph, bounded depth, cycle-guarded), plus the **reaching tests** (the test nodes the
     backward walk reaches);
   - returns the conclusion: read sites (file / line / function / required), the affected functions
     and files, the reaching tests, whether the var is declared in an `.env` file (`hasDefault`), and
     the honesty boundaries that make it a sound result.

The tool joins ONLY the opt-in `full` MCP preset (registered in `TOOL_DEFINITIONS`); it stays out of
the lean `navigation` default, so the first-run surface is unchanged (`mcp-quality`
MinimizeToolSurface). It is read-only, deterministic, offline.

## Scope and honest boundaries

- **Environment variables only.** Config-object key reads (`config.database.url`, a parsed YAML/JSON
  settings tree) are *not* in scope: resolving them soundly requires the config schema and is fuzzy
  across frameworks. The proposal name says "config" because env vars are the canonical 12-factor
  config flag; the tool name (`analyze_env_impact`) is scoped honestly to what it actually analyzes,
  and config-key reads are named as a disclosed, deferred boundary — never guessed.
- **Languages: TS/JS/Python/Go/Ruby** — exactly the set `env-extractor.ts` already scans. A repo in
  any other language simply yields no env read sites (the var may still be declared in an `.env`
  file), which is honest, not a false "nothing reads it".
- **Sound lower bound on the blast radius.** Dynamic dispatch, reflection, and module-level reads are
  disclosed as boundaries; the upstream-caller walk inherits the call graph's known limits (same as
  `analyze_impact`). A var read only at module top level is reported as such, never assumed unused.
- **Read-site `required` is a heuristic, disclosed.** A site is `required` when no immediate fallback
  (`?? ` / `||` for JS/TS; `os.environ[...]` / `ENV[...]` strict subscript; `ENV.fetch` with no
  default) is detected at that site; a fallback elsewhere does not clear it. This is the same
  fallback signal `env-extractor.ts` already uses, refined to per-site.

## Constraints honored

- **Determinism.** No LLM, no clock, no learned model; re-analysis of a fixed repo state is
  byte-identical. Read sites are sorted; the blast radius is sorted.
- **Conclusion over graph** (`mcp-quality`). The tool returns the computed impact answer (read sites +
  blast radius + tests + boundaries), never a node-and-edge dump.
- **Honesty over coverage.** Unknown var → not-found + candidates; module-level read → disclosed; an
  unsupported-language repo → no read sites, never a false negative; the blast radius is a sound lower
  bound with its limits named.
- **Tool-surface discipline.** New MCP tool defaults to opt-in (`full` preset only), never
  `MINIMAL_TOOLS` or the lean default.
- **Additive, no schema break.** No new persisted artifact and no change to the on-disk graph or env
  inventory — the tool computes live from the cached graph + a re-read of the relevant source (the
  `find_clones` / `analyze_error_propagation` precedent).

## Out of scope (explicitly considered)

- **Config-object / settings-tree key reads** — deferred (fuzzy without a schema; see above).
- **Writes / mutations of env vars** (`process.env.X = ...`) — the question is "what *reads* break if
  the var disappears"; writes are not reads and are not part of the impact set.
- **A persisted env-edge artifact** — live-compute is sufficient and matches the established
  no-new-artifact precedent; persisting would add a schema and a staleness surface for no gain.

At implementation time, `record_decision` is called before writing code (per project `CLAUDE.md`).
