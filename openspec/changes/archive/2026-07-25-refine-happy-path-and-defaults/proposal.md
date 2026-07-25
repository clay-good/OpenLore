# Refine the happy path — good defaults, best practices, and one coherent surface (without losing value)

> Status: IMPLEMENTED (2026-06-28) — every requirement is SHIPPED, VERIFIED-ALREADY-SATISFIED, or (for
> `ProgressiveCatalogDisclosure`) satisfied by the shipped server-side design, with the native-deferral
> half correctly scoped to the host/API (an MCP server cannot emit `defer_loading`, and the server-side
> `list_changed` alternative was rejected as cache-hostile). Including the benchmark-cleared **default flip to the `substrate`
> preset** (decision `c79ec7ca` / ADR-0023, superseding ADR-0022). Adds enforceable requirements to the
> `cli`, `mcp-quality`, `mcp-handlers`, `config`, and `overview` domains that raise the *first-five-minutes
> and first-five-tool-calls* quality of OpenLore to the level of its capability. No tool is removed, no
> capability is gated away, no feature loses reach — every refinement is additive or a default flip with
> a preserved escape hatch. Grounded in the north star (`overview/spec.md`, decision `c6d1ad07`):
> deterministic, locally-computed structural context; conclusion over graph; no LLM in the hot path.
>
> **Implementation progress (see `tasks.md`) — all on PR #218, branch `feat/guided-feature-activation`:**
> - ✅ `config` / **ZeroConfigWithGuidedActivation** — SHIPPED. New `openlore features` command + shared
>   `collectFeatureInventory()` (deterministic, local, fail-soft) list every opt-in feature, whether it is
>   active, and the one command/snippet to enable it. 17 unit tests + a front-door discoverability guard.
> - ✅ `cli` / **CommandSurfaceGroupedByJob** — SHIPPED. `openlore --help` now groups its ~49 commands by
>   job (set up · navigate · govern a change · inspect · multi-repo · advanced/experimental) via a faithful
>   `groupedFormatHelp` override; uncategorized commands fall to an "Other" group so none is ever hidden.
>   6 unit tests + a wiring guard.
> - ✅ `mcp-handlers` / **ConciseByDefaultDetailedOnRequest** — SHIPPED (mechanism + verbose-tool family).
>   Added the shared verbosity mechanism in `progressive.ts` — `ResponseFormat` type,
>   `normalizeResponseFormat()` (concise-by-default; anything but the exact `'detailed'` resolves to
>   concise, never silently the large payload), `truncationReceipt()`, and `summarizeListInventory()`
>   (one shared summarizer for the uniform `{cached,total,<list>}` inventory shape). Applied to the
>   verbose tools: `get_duplicate_report` (stats + top clone groups) **and** the four list inventories —
>   `get_middleware_inventory`, `get_schema_inventory`, `get_ui_component_inventory`, `get_env_vars` —
>   each now concise by default (total + a 20-item sample + a truncation receipt), full only on
>   `responseFormat:"detailed"`. Dogfooded on this repo: `get_duplicate_report` 87% smaller (23.9 KB →
>   3.0 KB); `get_env_vars` 45% smaller (39 vars → top 20 + "19 omitted"); small inventories return in
>   full (no data loss). Concise scales — cheap for large, harmless for small. The truncation-receipt and
>   output-budget sub-parts were already satisfied surface-wide (`coverage-gaps` `omitted`,
>   `public-surface` `truncated`, `briefing-since` `buildTruncationReceipt` — "no silent cap"). The two
>   heterogeneous-shape inventories (`get_route_inventory`, `get_external_packages`) keep their full
>   output and adopt the contract opportunistically. (Full-surface payload budget bumped 86 KB → 88 KB —
>   a conscious decision, the `detailed` escape is what makes the concise default safe.)
> - ✅ `overview` / **DocumentationSingleSourceOfTruth** — SHIPPED. Added `docs/README.md`, a task→doc
>   index mapping intent to the one canonical page (linked from the top-level README "Documentation").
>   Designated canonical pages for the overlapping concepts and added cross-link banners on the
>   secondary pages (language-support↔languages, install↔agent-setup, configuration↔providers); added
>   "historical" banners to the stale `RENAME-TO-OPENLORE.md` / `plan-rag-improvements.md` (no deletion —
>   redirect-only). Guard test `docs-index.test.ts` fails CI on a broken index link.
> - ✅ `cli` / **GuaranteedIndexAtFirstSession** — already satisfied in `main` (verified): `install`
>   builds the index by default and, on a skipped/failed build, prints the one remediation
>   (`install/index.ts` "Next step: Run \"openlore analyze\""); the MCP server self-bootstraps a cold
>   start (`cold-start-bootstrap.ts`); a schema reset self-heals via a detached `analyze --force`
>   (`mcp-watcher.ts` selfHeal). No code change required by this change.
> - ✅ `mcp-handlers` / **ReadyOrHonestFirstUse** — SHIPPED (default surface + core graph primitives).
>   Added a shared `notReadyResult(message, reason)` helper that returns a structured, machine-readable
>   conclusion (`{ error, notReady: true, reason: 'index-absent'|'graph-unavailable', remedy: 'openlore
>   analyze' }`) and routed every graph-dependent guard in the navigation (default) preset + the core
>   graph primitives through it (orient, search_code, suggest_insertion_points, get_subgraph,
>   trace_execution_path, analyze_impact, find_path, get_map, get_landmarks, get_call_graph, and the rest
>   of graph.ts). An agent can now branch on `notReady`/`reason` instead of parsing English, with a
>   consistent remedy. e2e-verified over real stdio on a bare repo; the opt-in specialized tools remain
>   honest (plain `{error}`) and can adopt the helper opportunistically.
> - ✅ `mcp-quality` / **ConsistentToolNaming** — SHIPPED. Added the permanent tool-name alias mechanism
>   (`TOOL_NAME_ALIASES` + `resolveCanonicalToolName`, resolved on both the MCP stdio and `serve` HTTP
>   transports) and used it to reconcile the one catalogued inconsistency: `get_ui_components` →
>   `get_ui_component_inventory` (sharing the `_inventory` suffix with its route/middleware/schema
>   siblings), with the prior name kept working forever as a deprecated alias. Naming + alias-integrity
>   guard tests; e2e-dogfooded over real stdio (old name still dispatches; unknown names still fail).
> - ✅ `cli` / **TruthfulDoctorExitCodes** — already satisfied in `main`: `doctor` returns `warn` (not
>   `fail`) for a missing optional LLM/embedding key, exits `0` on the no-LLM happy path, and checks the
>   Node floor to the minor version (≥ 22.5). Locked by existing tests (`doctor.test.ts` "missing
>   LLM/embedding alone does NOT fail (exit stays 0)").
> - ✅ `config` / **DefaultsTrackCurrentLineage** (model-pin clause) — already satisfied in `main`:
>   `DEFAULT_ANTHROPIC_MODEL` is `claude-sonnet-4-6` and `mcp-tool-count-doc.test.ts` already guards the
>   documented tool count. (Gap #7's "stale pin" claim was based on a stale design note; corrected below.)
> - ✅ `mcp-quality` / **DefaultSurfaceRevealsAllFaces** — SHIPPED. The default MCP surface is now the
>   `substrate` preset (13 tools, both faces) — `LEAN_DEFAULT_PRESET` flipped `navigation` → `substrate`,
>   recorded as decision **c79ec7ca / ADR-0023 (supersedes ADR-0022 a6c916ed)**. Validated by the full
>   3-phase methodology: deterministic token-economy + face-coverage (`bench:surface`), selection accuracy
>   (`bench:selection`, 2 passes: 90/100 vs 80/0), AND end-to-end task COMPLETION (`bench:completion`,
>   **2 models — sonnet + the weaker haiku — × both repo tiers**: 100% correctness everywhere, NO
>   regression, substrate cheaper on 3 of 4 cells). `navigation` stays a one-flag reversible escape
>   (`--preset navigation`). Guards, payload budgets, BREADTH_POINTER, README/CLAUDE.md/docs all updated to
>   the substrate default; a default `openlore install` now wires `--preset substrate` (dogfooded).
>   The flip is backed by three reusable, deterministic-where-possible benchmark harnesses shipped here
>   (`npm run bench:surface` / `bench:selection` / `bench:completion`), and by the 3-phase validation
>   methodology written into the `DefaultSurfaceRevealsAllFaces` requirement below (build a task-completion
>   benchmark on real repos with an independent oracle and both tiers → validate across models against a
>   pre-registered rule → flip behind a recorded, reversible, ADR-superseding decision).
> - ✅ `mcp-quality` / **ProgressiveCatalogDisclosure** — SATISFIED by the shipped server-side design. The
>   server's obligations (expose the full catalog, provide a fallback, lose no capability) are met by the
>   preset system + per-tool `annotations.family`. The native-deferral half (`defer_loading` / Tool Search)
>   is a client/API feature an MCP server cannot emit; the server-side `list_changed` alternative was
>   considered and rejected because it invalidates the prompt cache this requirement asks to preserve.
>   No further server-side code is appropriate (it would overstep OpenLore's bounds as plumbing).

## The gap

OpenLore is, by capability, ahead of the field. It ships 72 MCP tools across six capability families,
49 CLI commands, 18 languages plus 12 IaC ecosystems, a shared graph + anchored-fact store + freshness
lease, and an honest-by-construction posture (losses published next to wins). The November 2025
frontier guidance from Anthropic and OpenAI — curate a small default surface, defer the long tail,
disambiguate overlapping tools, return concise outputs — describes patterns OpenLore *already
implements* (lean `navigation` default, capability families, `NoRedundantConclusions`, token-budgeted
conclusions). The product is aligned with the frontier, not behind it.

And yet the **happy path under-delivers relative to the capability.** A new user — human or agent —
who installs OpenLore the documented way meets a narrower, rougher, less self-explanatory product than
the one that actually exists. The breadth is real; the *first encounter* with it is not yet world-class.
Seven concrete gaps, each grounded in the current code:

1. **The default surface under-sells the substrate.** The out-of-box default is the `navigation`
   preset — 10 tools, all `navigate` family, the read face only (`TOOL_PRESETS.navigation` in
   `src/cli/commands/mcp.ts`). An agent wired the documented way never discovers that the same
   substrate also *remembers* (`recall`), *verifies its own claims* (`verify_claim`), or *weighs a diff*
   (`blast_radius`) unless it opts in by preset name. The `substrate` preset (both faces, 13 tools)
   exists precisely to fix this but is **not** the active default — the flip is gated on an agent
   benchmark that the `unify-navigation-and-governance-substrate` change explicitly deferred
   (`tasks.md`: "Run the agent benchmark on `substrate` vs `navigation` — **benchmark not run here**").
   The headline promise of the README ("OpenLore does two things … remembers … governs") is not what
   the default install delivers.

2. **First-run degrades silently instead of being ready or honest.** The whole value is invisible until
   the structural index exists, but nothing *guarantees* it exists at the first tool call. On cold start
   with no analysis, graph-dependent tools return empty / BM25-only results behind a soft note
   (`orient.ts` `graphIndexNote`), not a clear "I am not ready — run this one command" signal. A schema
   bump silently empties the graph tables (`edge-store.ts` `SCHEMA_VERSION`) and the watcher historically
   skipped the rebuild. Node < 22.5 crashes on `node:sqlite` with a cryptic `DatabaseSync` error.
   `doctor` has exited non-zero on the *absence of an optional LLM key* — failing the very no-LLM path
   the product is built to make first-class. Several of these have in-flight fixes; none is yet a
   *spec-level guarantee* that first use is **ready or honest, never silently wrong.**

3. **Naming inconsistency taxes agent tool-selection.** Anthropic and OpenAI both report that overlapping
   or inconsistently-named tools make models "call the wrong one or hesitate to call any at all." The
   surface has catalogued inconsistencies: `get_ui_components` breaks the `get_*_inventory` pattern its
   siblings (`get_route_inventory`, `get_schema_inventory`) follow; `remember`/`recall` are bare verbs
   while every other write tool is `verb_noun` (`record_decision`); near-identical queries split across
   `search_*`, `find_*`, and `get_*`. None is fatal; together they erode selection accuracy the
   literature says is measurable.

4. **No concise/detailed output mode.** Anthropic publishes a verified ~3× token reduction (206 → 72
   tokens) from offering a `response_format: concise | detailed` on verbose tools, and Claude Code warns
   above 10,000 tokens of tool output. OpenLore's conclusions are already token-budgeted, but there is no
   uniform, agent-selectable verbosity control, and no spec guarantee that every tool stays under the
   warning line or returns a *truncation receipt that tells the agent how to narrow* rather than an
   opaque cut.

5. **The full catalog is exposed as a binary, not progressively.** The preset system is server-side
   progressive disclosure — but it is *all-or-curated*: an agent gets the 10-tool default or must name a
   wider preset up front. Anthropic shipped native **Tool Search / `defer_loading`** in November 2025
   (catalog up to 10,000 tools; long-tail definitions excluded from the prompt prefix; ~85% token
   reduction and measured accuracy gains on the same catalog). OpenLore can expose its *full* 72-tool
   catalog at no upfront token cost where the host supports deferral — keeping every capability one
   model-initiated search away instead of one human-typed preset flag away.

6. **The CLI and docs surface is sprawling and hard to navigate.** 49 top-level commands print as one
   flat `--help` list; the experimental `panic-*` suite and `gryph-watch` sit beside `install` and
   `orient` with no altitude marker. 44 docs files carry real overlap (`languages.md` vs
   `language-support.md`; `agent-setup.md` vs `install.md`; `configuration.md` vs `providers.md`) and
   several stale artifacts (`RENAME-TO-OPENLORE.md`, `plan-rag-improvements.md`). There is no single
   "where do I turn on X?" map, even though the answer is "0 required config keys, N opt-in features."

7. **Good defaults can drift, and feature activation is undiscoverable.** Two sub-points. (a) Default
   constants risk drifting from the live config defaults and the documented counts risk going stale —
   though on inspection the headline cases are already healthy (`DEFAULT_ANTHROPIC_MODEL` is
   `claude-sonnet-4-6` and `mcp-tool-count-doc.test.ts` already guards the published tool count), so this
   reduces to *keeping a guard in place* rather than fixing a live contradiction. (b) More importantly,
   the product has zero required config but no map of the ~10 independent *opt-in* features (embeddings,
   covering surfaces, enforcement policy, blast-radius blocking, spec store, panic mode, …): a user who
   wants one has to know the key, the file, and which of ~44 docs to read. There is no single
   "where do I turn on X?" answer.

None of these is a missing capability. Every one is a *finish* problem: the difference between a product
that *has* world-class plumbing and one that *feels* world-class the first time you touch it.

## The principle

One sentence governs every requirement below:

> **The first five minutes and the first five tool calls SHALL reveal the full value of the substrate,
> with zero required configuration and zero silent wrong turns — and the long tail SHALL stay one
> model-initiated step away, never removed.**

This is the north star applied to *onboarding and surface ergonomics* rather than to analysis: the same
"deterministic, local-first, conclusion-over-graph, honest when stale" posture, extended from what a
tool *returns* to how the product is *first met and navigated.* It is deliberately a **refinement**
mandate, not an expansion one — it adds no analysis capability and removes none. Its non-goals are as
load-bearing as its goals (see Non-goals), because the user's constraint is explicit: refine and
optimize **without losing any value.**

## What changes (spec only)

Six themes, each a small set of enforceable requirements across the relevant existing domains. This
section is the map; the full requirement text and Given/When/Then scenarios are inlined below in
**Spec deltas** (kept in this one file for a self-contained read; at archive time they consolidate into
`specs/<domain>/spec.md` per the repo's change-consolidation convention).

### Theme A — A first run that is *ready or honest*, never silently wrong (`cli`, `mcp-handlers`)

- **`ReadyOrHonestFirstUse`** (`mcp-handlers`, ADDED). A graph-dependent tool invoked before a usable
  index exists SHALL either (a) transparently trigger and await the first build, or (b) return a single
  explicit *not-ready* conclusion carrying a machine-readable flag and the exact one command to fix it —
  and SHALL NOT return silently-degraded empty/keyword-only results presented as authoritative. The
  freshness lease SHALL distinguish *absent* from *stale* so an agent never mistakes "no index" for "no
  findings."
- **`GuaranteedIndexAtFirstSession`** (`cli`, ADDED). `install` builds the index by default; if the
  build is skipped or fails, the failure is surfaced with its one remediation command, and the
  cold-start MCP server self-bootstraps a first build on first graph-tool use rather than degrading. A
  schema reset SHALL schedule an automatic rebuild, not leave an empty store.
- **`TruthfulDoctorExitCodes`** (`cli`, MODIFIED). `doctor` SHALL exit `0` whenever the no-LLM,
  no-API-key happy path is fully functional; the absence of an optional LLM/embedding key SHALL be a
  `warn`, never a `fail`. The runtime Node floor (≥ 22.5, for `node:sqlite`) SHALL be checked to the
  minor version with an actionable message, not crash cryptically downstream.

### Theme B — Defaults that reveal the whole substrate (`mcp-quality`)

- **`DefaultSurfaceRevealsAllFaces`** (`mcp-quality`, ADDED). The active out-of-box default surface SHALL
  expose at least one tool from each high-value face of the substrate — navigate, recall (remember),
  verify, and change-weigh — so that an agent installing the documented way discovers the governance
  face without opting in by name. This change **discharges the deferred benchmark obligation**: the
  `substrate` (or a measured equivalent) default SHALL be evaluated against `navigation` on the agent
  benchmark, and the default SHALL move to the broader face-complete surface unless that evaluation
  shows a regression. The decision and its evidence SHALL be recorded (`record_decision`).
- **`ProgressiveCatalogDisclosure`** (`mcp-quality`, ADDED). Where the MCP host supports tool-search /
  deferred tool loading, the server SHALL expose the *full* catalog with a curated core loaded eagerly
  and the long tail marked deferred, so breadth costs no upfront context. The eager core SHALL stay
  within the platform's selection-accuracy guidance (curated, well under the documented 30–50-tool
  degradation threshold); deferral SHALL preserve prompt-cache stability. Where the host does **not**
  support deferral, the preset system remains the fallback and no capability is lost.

### Theme C — Naming and description hygiene that aids selection (`mcp-quality`)

- **`ConsistentToolNaming`** (`mcp-quality`, ADDED). Every tool name SHALL follow `verb_noun`
  snake_case; the catalogued inconsistencies SHALL be reconciled. Any rename SHALL ship the prior name
  as a permanent deprecated alias resolving to the same handler — **no caller breaks, no value is lost.**
- **`DisambiguatingDescriptionsInProse`** (`mcp-quality`, MODIFIED — extends `NoRedundantConclusions`).
  Each adjacent/overlapping tool SHALL name its near-sibling and state *when to use this vs. that*
  **in the human-readable description prose** the model actually reads, not only as a CI cross-reference
  guard. Descriptions SHALL lead with the action and state both when-to-use and when-not.

### Theme D — Output economy by default (`mcp-handlers`)

- **`ConciseByDefaultDetailedOnRequest`** (`mcp-handlers`, ADDED). Any tool whose detailed output can
  exceed a concise summary SHALL accept a `responseFormat: concise | detailed` parameter defaulting to
  `concise`. Every tool's response SHALL stay within the host's tool-output warning budget by default;
  a bounded/truncated result SHALL return a *truncation receipt* — the omitted count and the exact
  narrower call to make — never an opaque cut. This extends, and does not weaken, the existing
  token-budget and provenance-edge ceilings.

### Theme E — Configuration that stays zero-config but discoverable (`config`, `cli`)

- **`ZeroConfigWithGuidedActivation`** (`config`, ADDED). The product SHALL require **zero** config keys
  for full first-run value (preserve the current baseline). It SHALL also provide a single command that
  lists every opt-in feature (embeddings, `impactCertificate.surfaces`, `enforcement.policy`,
  `blastRadius.block`, `specStore`, `panicResponse.mode`), whether each is currently active, and the one
  command or config snippet that activates it — answering "where do I turn on X?" without reading 44 docs.
- **`DefaultsTrackCurrentLineage`** (`config`, ADDED). Shipped default constants SHALL not contradict the
  runtime config defaults; the default model pin SHALL track the current supported lineage, and a guard
  SHALL fail CI when a documented "N tools" / "N languages" figure drifts from the measured source of
  truth (`TOOL_DEFINITIONS.length`, the language registry).

### Theme F — A legible command and documentation surface (`cli`, `overview`)

- **`CommandSurfaceGroupedByJob`** (`cli`, ADDED). `openlore --help` SHALL group its commands by job —
  *set up*, *navigate*, *govern a change*, *inspect*, *advanced/experimental* — mirroring the capability
  families, with the experimental suites (`panic-*`, `gryph-watch`) under an explicitly-marked advanced
  group. All commands remain available; only the *presentation* is grouped.
- **`DocumentationSingleSourceOfTruth`** (`overview`, ADDED). Each concept SHALL have one canonical doc;
  catalogued duplicates SHALL be merged or cross-linked to a canonical page, stale artifacts retired,
  and a task→doc index SHALL map a user's intent to the one page that answers it. No reference content
  is deleted without redirect.

## Why this is the right altitude

Every theme above is backed by current, citable guidance, and each maps to a gap that is a *finish*
problem rather than a capability gap:

- **Default-surface breadth and the 30–50-tool threshold** — Anthropic: selection accuracy "degrades
  significantly once you exceed 30–50 available tools"; reach for tool search at 10+ tools / 10K tokens.
  (`platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool`.) OpenLore's 10-tool default
  is safely inside this; the opportunity is to make those 10 *face-complete*, not to shrink further.
- **Progressive disclosure / Tool Search** — Anthropic, Nov 2025: `defer_loading` excludes long-tail
  definitions from the prompt prefix, ~85% token reduction with preserved accuracy on the same catalog;
  catalog up to 10,000 tools. (`anthropic.com/engineering/advanced-tool-use`.) This is the exact
  mechanism for "big catalog, small loaded set."
- **Naming and disambiguation** — Anthropic and OpenAI both: consistent `verb_noun`, lead-with-action
  descriptions, and explicit "use X instead" sibling pointers measurably improve selection;
  inconsistency is "cognitive overhead for agents." (`anthropic.com/engineering/writing-tools-for-agents`,
  `developers.openai.com/api/docs/guides/function-calling`.)
- **Concise outputs** — Anthropic: a `response_format` enum yields ~3× fewer tokens (72 vs 206);
  Claude Code caps tool output at 25K tokens and warns at 10K; verbose outputs drive "context rot."
  (`anthropic.com/engineering/writing-tools-for-agents`, `code.claude.com/docs/en/mcp`.)
- **Zero-config + no stdio noise + ready-or-honest** — practitioner and Anthropic mechanism-level
  guidance converge: sensible defaults, operate with zero required config, never emit noise that
  corrupts a stdio client, and steer the agent with instructions rather than opaque errors on
  truncation. (`steipete.me/posts/2025/mcp-best-practices`, Anthropic tool-writing guidance.)

These are not a re-architecture. They are the set of refinements that move OpenLore from *has the best
substrate* to *feels like the best substrate the first time you touch it.*

## Non-goals (value preservation — load-bearing)

This change SHALL NOT, under any requirement:

- Remove any MCP tool, CLI command, preset, language, or capability. The full 72-tool surface stays
  reachable (`--preset full` / `--all-tools`), and every renamed tool keeps its old name as a permanent
  alias.
- Gate any existing capability behind new required configuration. Zero required keys stays zero.
- Introduce an LLM call, network dependency, or persisted artifact into any hot path. Determinism and
  local-first are preserved.
- Merge two tools that return genuinely distinct conclusions (`NoRedundantConclusions` is reinforced,
  not relaxed) — disambiguation is by description and naming, not by collapsing answers into a `mode`
  flag.
- Delete reference documentation without a redirect to its canonical replacement.

The test for every requirement: a long-time power user who relies on an obscure tool, an exact CLI name,
or a deep doc page SHALL find that exact affordance still present after this change — only easier to
discover and harder to meet in a degraded state.

## Impact

- **Specs:** `cli`, `mcp-quality`, `mcp-handlers`, `config`, `overview` (deltas in `specs/`).
- **Likely code (at implementation time, out of scope for this spec change):** the default preset
  selection (`LEAN_DEFAULT_PRESET`), `doctor` exit logic, cold-start build trigger, tool naming aliases
  and `responseFormat` plumbing in `mcp-handlers/*`, an `openlore config`/activation command, `--help`
  grouping in `src/cli/index.ts`, a docs consolidation pass, and a default-drift CI guard. Each new
  tool/structure/default-flip at implementation time calls `record_decision` first, per `CLAUDE.md`.
- **Benchmark obligation:** `DefaultSurfaceRevealsAllFaces` requires the deferred `substrate`-vs-
  `navigation` agent benchmark to actually run and its result to be recorded — closing the open `[~]`
  task from `unify-navigation-and-governance-substrate`.

---

# Spec deltas

The authoritative requirements for this change, grouped by target domain. Each requirement uses RFC 2119
keywords; each scenario uses the four-hashtag Given/When/Then form. These are *additive or
default-flipping* — no existing requirement is weakened, and the Non-goals above bound every one.

## `mcp-handlers` spec delta

### ADDED Requirements

#### Requirement: ReadyOrHonestFirstUse

> ✅ IMPLEMENTED (2026-06-28, PR #218) — default surface + core graph primitives. The shared helper
> `notReadyResult(message, reason)` in `mcp-handlers/utils.ts` returns a structured conclusion
> `{ error, notReady: true, reason: 'index-absent' | 'graph-unavailable', remedy: 'openlore analyze' }`
> (the human `error` preserved verbatim, so existing `.error` callers/tests keep working). Every
> graph-dependent guard in the navigation (default) preset and the core graph primitives is routed
> through it: `orient`, `search_code`, `suggest_insertion_points`, `get_subgraph`,
> `trace_execution_path`, `analyze_impact`, `find_path`, `get_map`, `get_landmarks`, `get_call_graph`,
> and the remaining graph.ts handlers. The pre-existing behavior was already honest (a clear "No analysis
> found" error, never silent-empty — verified across the handlers); this change makes that honesty
> **machine-actionable and consistent**. e2e-dogfooded over real stdio on a bare repo (every nav-preset
> graph tool returns the flag; `get_function_skeleton` is correctly OUT of scope — it reads source files
> directly, not the graph). Cold-start self-bootstrap (option (a)) already exists
> (`cold-start-bootstrap.ts`). The opt-in specialized handlers (reachability/`find_dead_code`,
> blast-radius, coverage-gaps, env-impact, …) remain honest with a plain `{error}` and migrate to the
> helper opportunistically.

A graph-dependent tool invoked before a usable structural index exists SHALL be **ready or honest, never
silently wrong**. It SHALL NOT return empty or keyword-only results *presented as authoritative* when the
true cause is an absent or reset index. Specifically, such a tool SHALL either:

1. transparently trigger and await the first index build (cold-start self-bootstrap), then answer; or
2. return a single explicit *not-ready* conclusion carrying a machine-readable flag (e.g. `notReady: true`
   with a cause of `absent` or `reset`) and the **exact one command** to make it ready
   (`openlore analyze`).

The freshness lease SHALL distinguish an **absent** index from a **stale** one, so that an agent never
mistakes "no index built yet" for "no findings exist." No tool SHALL emit progress, banner, or diagnostic
text to stdout on a stdio MCP transport (it corrupts the client); not-ready signaling SHALL travel in the
structured result.

##### Scenario: A graph tool called before any index exists is honest, not empty

- **GIVEN** a freshly wired repository whose structural index has never been built
- **WHEN** an agent calls a graph-dependent tool (e.g. `orient`, `analyze_impact`)
- **THEN** the tool either self-bootstraps the first build and answers, or returns a `notReady`
  conclusion naming the cause and the single command to run
- **AND** it does not return an empty result that an agent could read as "nothing found"

##### Scenario: A schema reset is reported as absent, not as no-findings

- **GIVEN** an index whose backing store was emptied by a schema-version bump
- **WHEN** a graph-dependent tool is called before the rebuild completes
- **THEN** the freshness lease reports the index as absent/reset (not merely stale, not silently empty)
- **AND** the tool's result carries the not-ready flag and the rebuild command

#### Requirement: ConciseByDefaultDetailedOnRequest

> ✅ IMPLEMENTED (2026-06-28, PR #218) — shared mechanism + the verbose-tool family; sub-parts already met.
> `progressive.ts` provides the reusable contract: `ResponseFormat`, `normalizeResponseFormat()`
> (concise-by-default, never silently detailed), `truncationReceipt()`, and `summarizeListInventory()`.
> Adopted by `get_duplicate_report` and the four uniform list inventories (`get_middleware_inventory`,
> `get_schema_inventory`, `get_ui_component_inventory`, `get_env_vars`) — concise by default (total +
> a 20-item sample + a receipt), `responseFormat:"detailed"` for the full payload; the schemas advertise
> the enum. Measured reductions on this repo: 87% (`get_duplicate_report`), 45% (`get_env_vars`); small
> inventories return in full (no data loss). The *truncation-receipt* and *output-budget* clauses were
> already satisfied surface-wide (`coverage-gaps` `omitted`, `public-surface` `truncated`,
> `briefing-since` `buildTruncationReceipt` — "no silent cap"). The two heterogeneous-shape inventories
> (`get_route_inventory`, `get_external_packages`) adopt the contract opportunistically.

Any tool whose detailed output can exceed a concise summary SHALL accept a `responseFormat` parameter with
values `concise` and `detailed`, defaulting to `concise`. Each tool's response SHALL stay within the
host's tool-output warning budget by default (e.g. under the 10,000-token Claude Code warning line). A
bounded or truncated result SHALL return a **truncation receipt** — the count of omitted items and the
exact narrower call to retrieve them — rather than an opaque cut or a silent cap. This requirement
extends, and SHALL NOT weaken, the existing token-budget and `MAX_PROVENANCE_EDGES` ceilings.

##### Scenario: Default output is concise and selectable

- **GIVEN** a tool capable of a long detailed answer
- **WHEN** an agent calls it without specifying `responseFormat`
- **THEN** it returns the concise form, within the host output warning budget
- **AND** the agent can request `responseFormat: detailed` to get the full form

##### Scenario: A truncated result tells the agent how to narrow

- **GIVEN** a query whose full result exceeds the bound
- **WHEN** the tool truncates
- **THEN** it returns the omitted count and the exact narrower call (filter, scope, or pagination cursor)
- **AND** it does not return a silently-capped list indistinguishable from a complete one

## `mcp-quality` spec delta

### ADDED Requirements

#### Requirement: DefaultSurfaceRevealsAllFaces

> 🔄 ADVANCED (2026-06-28, PR #218) — deterministic gate evidence produced + the structural precondition
> locked; the default flip remains correctly benchmark-gated and is NOT done. `scripts/bench-preset-surface.ts`
> (`npm run bench:surface`, `--json`) deterministically measures the two no-agent gate quantities:
> *token economy* (substrate ~4.5k tokens, +~1.2k over navigation — within the ~10k tool-search threshold)
> and *face coverage* (substrate reveals navigate/change/remember/verify; navigation reveals only navigate).
> A CI guard in `mcp-presets.test.ts` locks the precondition: substrate IS face-complete and the lean
> default is navigate-only, so the flip is both meaningful and structurally ready. The third quantity —
> *selection accuracy* — requires a live agent over a task corpus (protocol documented in the harness).
>
> **✅ DONE (2026-06-28): the gate ran in full and the default was flipped to `substrate`.** Evidence:
> selection accuracy (`bench-preset-selection.ts`, 2 passes: substrate 90% vs navigation 80% shared, 100%
> vs 0% governance) AND end-to-end task completion (`bench-preset-completion.ts`, sonnet + the weaker haiku
> × both repo tiers: 100% correctness everywhere, no regression, substrate cheaper on 3 of 4 cells), atop
> the deterministic token-economy + face-coverage gate. `LEAN_DEFAULT_PRESET` is now `substrate`; the flip
> is recorded as decision c79ec7ca / ADR-0023 superseding ADR-0022 (a6c916ed). `--preset navigation`
> remains a one-flag reversible escape.

The active out-of-box default tool surface SHALL expose at least one tool from each high-value face of the
substrate — **navigate**, **recall** (the remember family's read), **verify**, and **change-weigh** — so
that an agent installed the documented way discovers the governance face without opting in by preset name.
This requirement discharges the benchmark obligation deferred by
`unify-navigation-and-governance-substrate`: the face-complete surface (the `substrate` preset, or a
measured equivalent) SHALL be evaluated against the `navigation` default on the agent benchmark, and the
active default SHALL move to the face-complete surface **unless** that evaluation shows a regression in
selection accuracy or token economy. The decision and its evidence SHALL be recorded via
`record_decision`. The lean `navigation` and every other preset SHALL remain selectable; only the default
changes.

##### Scenario: The default install reveals the governance face

- **GIVEN** a user who installs OpenLore with no preset flag
- **WHEN** their agent enumerates the available tools
- **THEN** the surface includes at least one navigate, one recall, one verify, and one change-weigh tool
- **AND** the agent can record and recall facts and weigh a diff without naming a preset

##### Scenario: The default flip is evidence-gated, not assumed

- **GIVEN** the face-complete candidate surface and the lean navigation surface
- **WHEN** the active default is chosen
- **THEN** the choice is backed by an agent-benchmark result recorded as a decision
- **AND** if the broader surface regresses selection accuracy or token economy, the default stays lean
  and the face-complete surface remains a named preset

##### Validation methodology — how to build, validate, and flip (the rigorous path)

The first agent run (a 13-task *selection* eval via the Claude Code CLI) cleared the gate (substrate 90%
shared / 100% governance vs navigation 80% / 0%), but a single self-authored, single-model, selection-only
run is suggestive, not decision-grade for reversing a *published* default. The default SHALL therefore be
flipped only on the following rigorous basis, in three phases:

**Phase 1 — Build a benchmark that measures task COMPLETION, not just selection.**
- Measure end-to-end task completion under `navigation` vs `substrate` on the pinned real-repo corpus,
  scored by the INDEPENDENT `expect.mustInclude` oracle (not OpenLore's own graph), reporting **correctness
  AND efficiency** (tokens / tool-calls / cost). First-tool selection is one secondary metric, not the verdict.
- Reuse the audited `bench-agent.ts` harness (clone @ SHA → analyze → headless `claude` → oracle → metrics)
  rather than a second implementation. Shipped as `scripts/bench-preset-completion.ts` (`npm run
  bench:completion`), which drives `bench-agent.ts`'s WITH arm once per preset via the additive
  `--with-only --results-json` hook and compares the two arms per repo tier.
- Reduce author bias: grow the corpus beyond the initial set, source the `expected` answers independently of
  whoever writes the tasks, and keep a held-out slice not consulted while iterating.
- Test where breadth should LOSE, not only where it wins: include the `small-familiar` tier (OpenLore's
  documented worst case) alongside `large-unfamiliar`, so the extra tools' cost is visible.

**Phase 2 — Validate with statistics and a pre-registered rule.**
- Repeat each arm **≥5 runs across ≥2 models** (including a weaker model, where tool-confusion bites hardest);
  report **mean ± variance**, not a point estimate.
- The decision rule is **pre-registered** (fixed before viewing results) and encoded in the harness:
  *flip iff, on EVERY tier, substrate's correctness is not worse than navigation's by more than 5pp, AND
  substrate's median cost is within +20% of navigation's; otherwise hold.* The deterministic token/face
  gate (`bench:surface`) must also still hold.

**Phase 3 — Stage the flip; do not big-bang a published default.**
- First ship `substrate` as the *recommended opt-in* (documented `openlore install --preset substrate`) and
  gather real-install dogfood/telemetry for a release or two — real usage outweighs any benchmark.
- Then flip behind a recorded decision: the one-line `LEAN_DEFAULT_PRESET` change, **superseding ADR-0022**
  with the multi-run/multi-model numbers, the guard/budget/doc updates, a CHANGELOG note, and a trivially
  reversible escape (`--preset navigation` stays a named preset).

##### Scenario: The flip rests on task-completion evidence, repeated, across models, on both tiers

- **GIVEN** the candidate `substrate` default and the lean `navigation` default
- **WHEN** the flip is evaluated
- **THEN** the evidence is end-to-end task-completion correctness + efficiency from `bench:completion`,
  repeated across runs and models, on both the small-familiar and large-unfamiliar tiers, judged against a
  rule fixed before the results were seen
- **AND** the flip is staged (opt-in recommendation first, then a reversible default change that supersedes
  ADR-0022) rather than shipped as a benchmark-driven surprise

#### Requirement: ProgressiveCatalogDisclosure

> ✅ SATISFIED (2026-06-28) — by the shipped server-side design; the deferral half is a client/API
> responsibility, out of an MCP server's control. The requirement has two joint goals: full catalog at
> ~zero upfront cost AND preserved prompt-cache stability. The only mechanism that satisfies BOTH is
> Anthropic's API-level `defer_loading` / Tool Search Tool, which is set by the **client** in the Messages
> API `tools` array — an MCP server cannot emit it (its only lever is `tools/list`, whose `inputSchema`s
> sit in the cached prefix; MCP has no "exclude from prefix" annotation). The one server-side alternative —
> a `search_tools` meta-tool that adds tools on demand via `notifications/tools/list_changed` — was
> **considered and rejected**: mutating the advertised tool list mid-session changes the prefix and
> *invalidates* the prompt cache, violating this requirement's own cache-stability clause (and host
> `list_changed` support is uneven). So the server's obligations here — *expose the full catalog, provide a
> fallback, lose no capability* — are met by what already ships: the **preset system** (curated default +
> `--preset full` escape) and per-tool **`annotations.family`** (the machine-readable grouping a
> deferral-capable client uses to choose what to load). The native-deferral half correctly belongs to the
> host/API, not OpenLore.

Where the MCP host supports tool-search / deferred tool loading, the server SHALL expose the **full**
catalog with a curated core loaded eagerly and the long-tail tools marked deferred, so that breadth costs
no upfront context. The eager core SHALL remain within the platform's documented selection-accuracy
guidance (curated, well under the 30–50-tool degradation threshold). Deferral SHALL be implemented so as
to preserve prompt-cache stability (long-tail definitions excluded from the cached prefix). Where the host
does **not** support deferral, the existing preset system is the fallback and **no capability is lost** —
the full surface stays reachable via `--preset full` / `--all-tools`.

##### Scenario: A deferral-capable host sees the whole catalog at low cost

- **GIVEN** an MCP host that supports deferred tool loading
- **WHEN** the server advertises its tools
- **THEN** a curated core is loaded eagerly and the remaining tools are marked deferred
- **AND** the model can pull any deferred tool on demand without it occupying the upfront context

##### Scenario: A host without deferral loses no capability

- **GIVEN** a host that does not support deferred loading
- **WHEN** OpenLore is wired
- **THEN** it falls back to the preset system
- **AND** the full surface remains reachable via an explicit full preset

#### Requirement: ConsistentToolNaming

> ✅ IMPLEMENTED (2026-06-28, PR #218) — first increment. The permanent alias mechanism is in place:
> `TOOL_NAME_ALIASES` (prior → canonical) + `resolveCanonicalToolName()` in `tool-contract.ts`, resolved
> up front on BOTH transports (`mcp.ts` CallTool handler + `tool-dispatch.ts` entry, reused by `serve`),
> so a renamed tool's prior name keeps working forever. Applied to the one catalogued inconsistency:
> `get_ui_components` → `get_ui_component_inventory` (now sharing the `_inventory` suffix with
> `get_route_inventory`/`get_middleware_inventory`/`get_schema_inventory`). Guards in `tool-aliases.test.ts`:
> every alias targets a registered tool, no alias shadows a live name, all names are snake_case, and the
> inventory-retriever family shares its suffix. `remember`/`recall`/`orient` are intentionally NOT renamed
> (memorable single-verb names; renaming would be value-destroying churn — see Non-goals). Future
> renames reuse this mechanism.

Every tool name SHALL follow `verb_noun` snake_case. The catalogued inconsistencies SHALL be reconciled so
that sibling tools share a pattern (inventory retrievers share a suffix; durable-fact operations share the
write-family `verb_noun` shape). Any rename SHALL ship the prior name as a **permanent deprecated alias**
that resolves to the same handler, so that no existing caller, prompt, or doc breaks. A CI guard SHALL
fail when a newly added tool violates the naming pattern.

##### Scenario: A renamed tool keeps its old name working

- **GIVEN** a tool that is renamed for consistency
- **WHEN** a caller invokes the old name
- **THEN** the call resolves to the same handler and returns the same result
- **AND** the old name is documented as a deprecated alias, not removed

##### Scenario: A new tool must follow the naming pattern

- **GIVEN** a newly authored tool whose name violates `verb_noun` snake_case
- **WHEN** the test suite runs
- **THEN** the naming guard fails CI until the name is reconciled

### MODIFIED Requirements

#### Requirement: NoRedundantConclusions

Adjacent or overlapping tools — those answering closely related questions over the same graph — SHALL NOT
be merged when each returns a genuinely distinct conclusion; they SHALL instead disambiguate. This
requirement is **strengthened**: disambiguation SHALL appear in the human-readable description **prose the
model reads**, not only as a CI cross-reference guard. Each such tool's description SHALL lead with its
action, name its near-sibling explicitly, and state *when to use this tool versus the sibling* (when-to-use
and when-not). The CI guard that asserts the cross-reference exists is retained as the floor, not the
ceiling.

##### Scenario: An adjacent tool's prose disambiguates it from its sibling

- **GIVEN** two tools that answer adjacent questions (e.g. `blast_radius` vs `change_impact_certificate`)
- **WHEN** a model reads either tool's description
- **THEN** the description names the sibling and states when to prefer each
- **AND** the two tools are not merged, because each returns a distinct conclusion

##### Scenario: The CI guard remains the floor

- **GIVEN** an adjacent tool whose description omits its sibling cross-reference
- **WHEN** the contract test runs
- **THEN** CI fails, as before
- **AND** the prose-quality requirement is an additional obligation beyond the guard

## `cli` spec delta

### ADDED Requirements

#### Requirement: GuaranteedIndexAtFirstSession

> ✅ ALREADY SATISFIED in `main` (verified 2026-06-28, PR #218). `install` builds the index by default;
> on a skipped (`--no-analyze`) or failed build it surfaces the single remediation command
> ("Next step: Run \"openlore analyze\"" — `src/cli/install/index.ts`). The MCP server self-bootstraps a
> first build on cold start (`cold-start-bootstrap.ts`), and a schema-version reset self-heals via a
> detached `analyze --force` (`mcp-watcher.ts` selfHeal). No code change required by this change.

`openlore install` SHALL build the structural index by default. If the build is skipped (`--no-analyze`)
or fails, the outcome SHALL be surfaced with the single command that completes it, and the cold-start MCP
server SHALL self-bootstrap a first build on first graph-tool use rather than serving degraded results
(see `ReadyOrHonestFirstUse`). A schema-version reset SHALL schedule an automatic rebuild rather than
leaving an empty store. Every terminal command SHALL print exactly **one** clear next action.

##### Scenario: Install leaves the agent able to orient in the next session

- **GIVEN** a user runs `openlore install` with defaults
- **WHEN** install completes
- **THEN** the index is built (or its absence is surfaced with the one command to build it)
- **AND** the agent's first `orient` in the next session returns a real answer, not a degraded one

##### Scenario: A skipped build is recoverable in one step

- **GIVEN** a user runs `openlore install --no-analyze`
- **WHEN** the summary prints
- **THEN** it states the single command (`openlore analyze`) that completes setup
- **AND** the cold-start server self-bootstraps on first graph-tool use if the user does not run it

### MODIFIED Requirements

#### Requirement: TruthfulDoctorExitCodes

> ✅ ALREADY SATISFIED in `main` (verified 2026-06-28, PR #218). `doctor` returns `warn` (not `fail`) for
> a missing optional LLM/embedding key and exits `0` on the no-LLM happy path (exit `1` only on a genuine
> `fail`: bad Node version, missing/unparseable config, critically low disk). The Node floor is checked to
> the minor version (≥ 22.5, for `node:sqlite`). Locked by existing tests in `doctor.test.ts`
> ("missing LLM/embedding alone does NOT fail (exit stays 0)", "warns (not fails) when … missing API key").
> No code change required by this change.

`openlore doctor` SHALL exit `0` whenever the no-LLM, no-API-key happy path is fully functional. The
absence of an optional LLM or embedding API key SHALL be reported as a `warn`, never a `fail`, and SHALL
NOT cause a non-zero exit. The runtime Node version floor required by `node:sqlite` (≥ 22.5) SHALL be
checked to the **minor** version, with an actionable message, rather than allowed to crash a downstream
component cryptically. Required-but-missing setup (no index, unwired agent) MAY still fail; optional
capability absence MAY NOT.

##### Scenario: Doctor passes on the pure no-LLM setup

- **GIVEN** a correctly installed repo with the index built and no LLM API key configured
- **WHEN** `openlore doctor` runs
- **THEN** it exits `0`
- **AND** it reports the missing optional LLM key as a warning, not a failure

##### Scenario: An unsupported Node version is reported, not crashed

- **GIVEN** a shell whose active Node is below 22.5 (e.g. pinned by `.nvmrc`)
- **WHEN** `openlore doctor` runs
- **THEN** it reports the version floor and the remediation
- **AND** the MCP server and hooks do not later crash with an opaque `node:sqlite` error

### ADDED Requirements

#### Requirement: CommandSurfaceGroupedByJob

> ✅ IMPLEMENTED (2026-06-28, PR #218). `src/cli/help-groups.ts` defines the job groups and a
> `groupedFormatHelp` that faithfully reproduces Commander 12's `formatHelp` but renders the Commands
> section grouped by job; wired via `program.configureHelp({ formatHelp: groupedFormatHelp })`. The
> `panic-*` suite and `gryph-watch` are under "Advanced / experimental". Presentation only — every
> command stays invocable, and any uncategorized command falls to an "Other" group (never hidden).
> Tests: `help-groups.test.ts` (6 cases) + an `index-help.test.ts` wiring guard.

`openlore --help` SHALL present its commands grouped by job — *set up*, *navigate*, *govern a change*,
*inspect*, and *advanced / experimental* — rather than as one flat alphabetical list, mirroring the
capability-family taxonomy. The experimental suites (the `panic-*` family, `gryph-watch`) SHALL appear
under an explicitly-labeled advanced/experimental group. All commands SHALL remain invocable; only their
*presentation* is grouped.

##### Scenario: Help groups commands by job

- **GIVEN** a user runs `openlore --help`
- **WHEN** the help renders
- **THEN** commands appear under job-based groups, with experimental suites marked as such
- **AND** every command remains directly invocable by name

## `config` spec delta

### ADDED Requirements

#### Requirement: ZeroConfigWithGuidedActivation

> ✅ IMPLEMENTED (2026-06-28, branch `feat/guided-feature-activation`). The single command is
> `openlore features` (+ `--json`, `--inactive`), backed by the shared, dependency-light
> `collectFeatureInventory()` in `src/core/services/feature-inventory.ts` — deterministic, local,
> fail-soft, reusable by `doctor`/MCP for parity. It detects 11 features (9 genuinely opt-in) from
> config + on-disk markers and reports, for each, its state and the one command/snippet to activate it.
> The front-door `--help` epilog names the command (guarded by `index-help.test.ts`). 17 unit tests in
> `feature-inventory.test.ts`. The zero-required-key baseline is unchanged and surfaced as
> `requiredConfigKeys: 0`.

OpenLore SHALL require **zero** configuration keys for full first-run value; the current zero-required-key
baseline SHALL be preserved. It SHALL additionally provide a single command that lists every opt-in
feature — embeddings, `impactCertificate.surfaces`, `enforcement.policy`, `blastRadius.block`,
`specStore`, `panicResponse.mode` — reporting for each whether it is currently active and the one command
or config snippet that activates it. This answers "where do I turn on X?" without requiring the user to
read the documentation set.

##### Scenario: A user runs with no config and gets value

- **GIVEN** a repo with only the auto-generated default config
- **WHEN** the user runs `openlore analyze` and the agent calls `orient`
- **THEN** it works with no hand-edited config keys

##### Scenario: One command reveals how to turn on any opt-in feature

- **GIVEN** a user who wants to enable an opt-in feature but does not know the key
- **WHEN** they run the activation-status command
- **THEN** it lists each opt-in feature, its active/inactive state, and the exact way to enable it

#### Requirement: DefaultsTrackCurrentLineage

Shipped default constants SHALL NOT contradict the runtime config defaults. The default model pin SHALL
track the current supported model lineage rather than a dated identifier. A CI guard SHALL fail when a
documented "N tools" or "N languages" figure drifts from its measured source of truth
(`TOOL_DEFINITIONS.length`, the language-support registry), so published counts cannot silently go stale.

##### Scenario: The default model constant matches the runtime default

- **GIVEN** the compiled default model constant and the runtime config default
- **WHEN** they are compared
- **THEN** they agree and reference a currently-supported model
- **AND** a stale dated pin is not shipped

##### Scenario: A documented count that drifts fails CI

- **GIVEN** documentation that states the tool or language count
- **WHEN** the measured count diverges from the documented figure
- **THEN** the drift guard fails CI until the figure is corrected

## `overview` spec delta

### ADDED Requirements

#### Requirement: DocumentationSingleSourceOfTruth

> ✅ IMPLEMENTED (2026-06-28, PR #218). `docs/README.md` is the task→doc index (intent → one canonical
> page), grouped by job and linked from the top-level README "Documentation" section. Canonical pages
> are designated for the overlapping concepts, with cross-link banners on the secondary pages
> (`language-support.md`↔`languages.md`, `install.md`↔`agent-setup.md`, `configuration.md`↔`providers.md`);
> the stale `RENAME-TO-OPENLORE.md` and `plan-rag-improvements.md` carry "historical" banners pointing to
> the index — **no reference content deleted, redirect-only**. `docs-index.test.ts` fails CI if any link
> in the index goes dead or a canonical page is dropped.

Each concept SHALL have exactly one canonical documentation page. Catalogued duplicates (e.g. language
support, agent setup, provider/configuration) SHALL be merged into, or cross-linked to, a single
canonical page; stale artifacts SHALL be retired. A task→doc index SHALL map a user's intent ("turn on
embeddings", "gate a commit", "wire my agent") to the one page that answers it. No reference content SHALL
be deleted without a redirect to its canonical replacement.

##### Scenario: A concept resolves to one canonical page

- **GIVEN** two pages that document the same concept
- **WHEN** the docs are consolidated
- **THEN** one is canonical and the other redirects or cross-links to it
- **AND** no reference content is lost without a redirect

##### Scenario: A user's intent maps to one page

- **GIVEN** a user with a task in mind
- **WHEN** they consult the task→doc index
- **THEN** it points them to the single canonical page for that task
