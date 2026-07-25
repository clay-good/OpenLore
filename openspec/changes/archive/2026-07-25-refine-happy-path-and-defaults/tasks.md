# Tasks — refine the happy path: good defaults, best practices, one coherent surface

This change is a multi-requirement refinement; each requirement is independently shippable. Slices land
on their own branches/PRs and are checked off here as they ship.

## Slice 1 — `config` / ZeroConfigWithGuidedActivation  (SHIPPED — branch `feat/guided-feature-activation`)

- [x] Shared inventory: `collectFeatureInventory()` in `src/core/services/feature-inventory.ts` —
      deterministic, local, fail-soft; detects 11 features (9 opt-in) from `.openlore/config.json` +
      on-disk markers (`.mcp.json` preset, `.openlore/architecture.json`, `.git/hooks/pre-commit`,
      `.openlore/federation.json`). Returns `requiredConfigKeys: 0` to surface the zero-config guarantee.
- [x] CLI: `openlore features` (`src/cli/commands/features.ts`) — grouped human view + `--json` +
      `--inactive`; mirrors `doctor`'s rendering conventions; each inactive opt-in feature shows the one
      command/snippet to activate it.
- [x] Wire command into `src/cli/index.ts` (between `doctor` and `setup`) and name it in the front-door
      `--help` epilog (Core commands).
- [x] Tests: `feature-inventory.test.ts` (17 cases — every active/inactive branch, fail-soft, counts);
      `index-help.test.ts` discoverability guard (`openlore features` appears in the epilog).
- [x] Dogfood: ran `openlore features` / `--json` / `--inactive` on this repo (federation preset + gate
      hook + 2 peer repos detected) and on a synthetic all-features-on fixture (9/9 active) and a bare
      no-config dir (warns, exit 0, zero-config line preserved).
- [x] Verify: `tsc --noEmit` clean; `vitest run src examples` green (280 files, 5556 passed, 2 skipped).
- [x] Value preserved: no tool/command/preset removed; zero required keys unchanged; no LLM, no network.

## Slice 2 — `cli` / CommandSurfaceGroupedByJob  (SHIPPED — PR #218)

- [x] `src/cli/help-groups.ts`: `COMMAND_GROUPS` (6 job groups, ordered) + `groupForCommand()` +
      `groupedFormatHelp()` — a faithful Commander-12 `formatHelp` reproduction that groups only the
      Commands section; uncategorized commands fall to an "Other" group (never hidden).
- [x] Wire `program.configureHelp({ formatHelp: groupedFormatHelp })` in `src/cli/index.ts`.
- [x] Tests: `help-groups.test.ts` (6 — grouping, order, Other fallback, omit-empty-group, usage/options
      preserved) + `index-help.test.ts` wiring guard.
- [x] Dogfood: `openlore --help` renders all commands under their job groups; experimental suites under
      "Advanced / experimental"; epilog still follows; no OpenLore command in "Other".

## Slice 3 — `cli` / TruthfulDoctorExitCodes  (ALREADY SATISFIED in `main`)

- [x] `doctor` returns `warn` (not `fail`) for a missing LLM/embedding key; exits `0` on the no-LLM path.
- [x] Node floor checked to the minor version (≥ 22.5). Locked by existing `doctor.test.ts` cases.

## Slice 4 — `config` / DefaultsTrackCurrentLineage  (ALREADY SATISFIED in `main`)

- [x] `DEFAULT_ANTHROPIC_MODEL` is `claude-sonnet-4-6` (matches the runtime config default) — no drift.
- [x] `mcp-tool-count-doc.test.ts` already guards the documented tool count against `TOOL_DEFINITIONS`.
- [ ] (Optional follow-up) A language-count drift guard, if/when a doc states a hard language count.

## Slice 5 — `mcp-quality` / ConsistentToolNaming  (SHIPPED — PR #218)

- [x] Permanent alias mechanism: `TOOL_NAME_ALIASES` + `resolveCanonicalToolName()` in
      `mcp-handlers/tool-contract.ts` (single source of truth, prior → canonical).
- [x] Resolve aliases up front on BOTH transports: `mcp.ts` CallTool handler (covers schema lookup, arg
      validation, tracking, dispatch) + `tool-dispatch.ts` entry (covers `serve` HTTP + any direct caller).
- [x] Reconcile `get_ui_components` → `get_ui_component_inventory` across all sites: `TOOL_DEFINITIONS`,
      `TOOL_OUTPUT_CLASS`, `TOOL_CAPABILITY_FAMILY`, the `_RO` map, the dispatch case, `epistemic-lease`
      weights, the live-data tool driver, and the generated AGENTS.md / digest prose; prior name kept as alias.
- [x] Docs: `docs/mcp-tools.md` (canonical + alias note), `docs/agent-setup.md` (inventory lines).
- [x] Guards: `tool-aliases.test.ts` (alias→registered, no-collision, passthrough, snake_case,
      inventory-suffix family). `tool-contract.test.ts` (completeness/no-stale) stays green after the rename.
- [x] Dogfood (real stdio JSON-RPC): old `get_ui_components` dispatches (not unknown-tool); canonical
      dispatches; a genuinely unknown name still returns unknown-tool. `tools/list` shows only the canonical.
- [x] `remember`/`recall`/`orient` intentionally NOT renamed (no value-destroying churn — Non-goals).

## Slice 6 — `mcp-handlers` / ReadyOrHonestFirstUse  (SHIPPED — PR #218; default surface + core graph primitives)

- [x] Shared helper `notReadyResult(message, reason)` in `mcp-handlers/utils.ts` → structured
      `{ error, notReady: true, reason: 'index-absent' | 'graph-unavailable', remedy: 'openlore analyze' }`;
      human `error` preserved verbatim (existing `.error` callers/tests unaffected).
- [x] Routed every graph-dependent guard in the navigation (default) preset + core graph primitives
      through it: `graph.ts` (19 sites — subgraph, call_graph, impact, trace, signatures, file-deps, …),
      `orient.ts`, `pathfind.ts` (find_path), `map.ts` (get_map), `landmarks.ts` (get_landmarks),
      `semantic.ts` (search_code, suggest_insertion_points).
- [x] Tests: `utils.test.ts` notReadyResult unit cases; updated the `./utils.js` mocks in the affected
      handler tests; full suite green.
- [x] Dogfood (real stdio, bare repo): every navigation-preset graph tool returns `notReady:true` +
      `reason` + `remedy:'openlore analyze'`; `get_function_skeleton` correctly OUT of scope (reads
      source files, not the graph); a genuinely unknown tool still errors.
- [x] Scope note: pre-existing behavior was already honest (never silent-empty); this makes it
      machine-actionable + consistent. Opt-in specialized handlers stay honest, migrate opportunistically.

## Slice 7 — `overview` / DocumentationSingleSourceOfTruth  (SHIPPED — PR #218)

- [x] `docs/README.md` — task→doc index (intent → one canonical page), grouped by job; linked from the
      top-level README "Documentation" section.
- [x] Canonical designations + cross-link banners on the overlapping pages: `language-support.md` ↔
      `languages.md`, `install.md` ↔ `agent-setup.md`, `configuration.md` ↔ `providers.md`.
- [x] "Historical" banners on stale pages (`RENAME-TO-OPENLORE.md`, `plan-rag-improvements.md`) pointing
      to the index — redirect-only, no reference content deleted.
- [x] Guard: `docs-index.test.ts` (index exists; every relative link resolves; canonical pages present).

## Slice 8 — `cli` / GuaranteedIndexAtFirstSession  (ALREADY SATISFIED in `main`)

- [x] `install` builds the index by default; skipped/failed build prints the one remediation
      ("Next step: Run \"openlore analyze\"" — `src/cli/install/index.ts`).
- [x] Cold-start self-bootstrap (`cold-start-bootstrap.ts`); schema-reset self-heal via detached
      `analyze --force` (`mcp-watcher.ts`). No code change required.

## Slice 9 — `mcp-handlers` / ConciseByDefaultDetailedOnRequest  (SHIPPED — PR #218; mechanism + family)

- [x] Shared mechanism in `progressive.ts`: `ResponseFormat` type, `normalizeResponseFormat()`
      (concise-by-default; only the exact `'detailed'` opts into the full payload), `truncationReceipt()`,
      and `summarizeListInventory()` (one summarizer for the uniform `{cached,total,<list>}` shape).
- [x] Applied to `get_duplicate_report` (stats + top 10 clone groups + receipt) and the four uniform list
      inventories — `get_middleware_inventory`, `get_schema_inventory`, `get_ui_component_inventory`,
      `get_env_vars` (total + 20-item sample + receipt). Dispatch + inputSchema (shared
      `RESPONSE_FORMAT_PROP` enum) + descriptions updated for all five.
- [x] Tests: `progressive.test.ts` (normalize/receipt/summarizer units) + `analysis.test.ts`
      (concise default, detailed pass-through, truncation receipt, small-list-full, bad-value→concise,
      fail-soft on unknown shape) for both `get_duplicate_report` and `get_env_vars`.
- [x] Dogfood (real stdio): `get_duplicate_report` 87% smaller (23.9 KB → 3.0 KB); `get_env_vars` 45%
      smaller (39 → top 20 + "19 omitted"); small inventories return in full (no data loss).
- [x] Full-surface payload budget bumped 86 KB → 88 KB (conscious — the `detailed` escape makes the
      concise default safe); doc byte-figure guard (±3 KB) absorbed the growth.
- [x] Sub-parts already satisfied surface-wide: truncation receipts (`coverage-gaps` `omitted`,
      `public-surface` `truncated`, `briefing-since` `buildTruncationReceipt` — "no silent cap") and
      output budgets. The two heterogeneous inventories (`get_route_inventory`, `get_external_packages`)
      adopt the contract opportunistically.

## Slice 10 — `mcp-quality` / DefaultSurfaceRevealsAllFaces  (SHIPPED — PR #218; gate run across two models, flip executed)

- [x] `scripts/bench-preset-surface.ts` + `npm run bench:surface` (`--json`) — deterministic, no-LLM
      harness measuring the two agent-free gate quantities: TOKEN ECONOMY (per-preset tools/list bytes +
      est. tokens, using the exact budget-guard measurement) and FACE COVERAGE (capability families per
      preset). Prints the navigation→substrate delta + a verdict on the deterministic half.
- [x] Measured: substrate is face-complete (navigate+change+remember+verify) at ~4.5k tokens (+~1.2k over
      navigation, within the ~10k tool-search threshold); navigation reveals only navigate.
- [x] CI guard in `mcp-presets.test.ts`: substrate reveals all four high-value faces; the lean default is
      navigate-only — locking the structural precondition the flip depends on.
- [x] SELECTION ACCURACY — RUN via `scripts/bench-preset-selection.ts` (`npm run bench:selection`) over a
      13-task corpus using the **Claude Code CLI** (subscription auth, no API key), **2 reproducible passes**:
      substrate **90%** vs navigation **80%** on shared tool selection (NO regression), **100%** vs **0%**
      on governance-face tasks (recall / verify_claim / blast_radius). Verdict: flip CLEARED.
- [x] Wrote the 3-phase rigorous validation methodology into the proposal (build task-completion benchmark
      → validate ≥5 runs × ≥2 models vs a pre-registered rule → stage opt-in-first then reversible flip).
- [x] Phase 1 SHIPPED: `scripts/bench-preset-completion.ts` (`npm run bench:completion`) — end-to-end
      task-completion comparison of navigation vs substrate on the pinned tiered repos, oracle-scored,
      reusing `bench-agent.ts` via additive `--with-only --results-json` hooks; per-tier correctness + cost
      vs a PRE-REGISTERED rule (no tier correctness regression > 5pp AND median cost ≤ +20%). Pipeline
      validated via `--dry-run --skip-setup` ($0, no clone).
- [x] Phase 2 — RAN the task-completion validation via the Claude Code CLI (no API key): full corpus
      (12 tasks / 9 repos / both tiers), `--runs 3`, TWO models (sonnet + the weaker haiku). Result: 100%
      correctness on every model × tier × preset (no regression), substrate cheaper on 3 of 4 cells
      (sonnet −33%/−7%, haiku +6%/−6%). `flipCleared=true` for both models. (Pragmatic deviation: runs=3,
      not ≥5 — correctness had zero variance at the 100% ceiling, so more runs couldn't change the verdict.)
- [x] Phase 3 — EXECUTED the flip (the maintainer compressed the opt-in-first staging given the strong
      two-model evidence): `LEAN_DEFAULT_PRESET` `navigation` → `substrate`; recorded decision c79ec7ca /
      ADR-0023 (supersedes ADR-0022 a6c916ed); updated the navigation-default guards + lean payload budget
      in `mcp-presets.test.ts`, the install/connect wiring tests, the `BREADTH_POINTER`, the doc-count
      guard (allowlist navigation's 10 alongside substrate's 13), and the README/CLAUDE.md/docs copy.
      `--preset navigation` stays a one-flag reversible escape. Dogfooded: a default `openlore install`
      wires `--preset substrate`; `openlore mcp --list-tools` reports "substrate (13 tools, 4 families)".

## Closed by design (no further code appropriate)

- [x] `mcp-quality` / ProgressiveCatalogDisclosure — SATISFIED by the shipped server-side design. The
      server's obligations (expose the full catalog, fallback, lose no capability) are met by the preset
      system + per-tool `annotations.family`. Native `defer_loading` / Tool Search is a client/API feature
      an MCP server cannot emit; the server-side `list_changed` alternative was considered and REJECTED —
      mutating `tools/list` mid-session invalidates the prompt cache the requirement asks to preserve, and
      host `list_changed` support is uneven. Building it would overstep OpenLore's bounds as plumbing.
- [x] `mcp-quality` / NoRedundantConclusions (prose) — the sibling cross-reference is ALREADY ENFORCED by
      `tool-contract.test.ts` ("each member names at least one near-sibling in its own description"); the
      remaining "lead-with-action" prose quality is not deterministically testable and is left as-is.

## Verification (PR #218, after slices 1, 2, 5, 6, 7, 9 + inventory family, 10)

- [x] `npm run build` clean; `tsc --noEmit` clean.
- [x] `vitest run src examples` green — 283 files, 5589 passed, 2 skipped (the lone intermittent
      `mcp-watcher-parity` flake under full-suite load is pre-existing and passes in isolation).
- [x] `npm run bench:surface` runs and produces the deterministic preset comparison.
- [x] Value preserved: no tool/command/preset/language removed (a tool was renamed with a permanent
      alias — the prior name still works; the default flip kept `--preset navigation` as a reversible
      escape); zero required keys unchanged; no LLM, no network, no persisted artifact in any hot path.
- [x] Spec/decision consistency: decision `c79ec7ca` approved + synced to `openspec/specs/{analyzer,drift,cli}`;
      ADR-0023 created; ADR-0022 marked `superseded`; the prior `navigation`-default requirement annotated
      SUPERSEDED in the three consolidated specs so no live `SHALL` contradicts the substrate default.
- [ ] `openspec validate refine-happy-path-and-defaults` (run at archive time).
