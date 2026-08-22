# Changelog

All notable changes to OpenLore are documented here. This project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

- **Programmatic API migration:** analysis results now require `fromCache` and make
  `depGraph` optional when the persisted graph is missing or corrupt. Generation and full-run
  results are discriminated by `dryRun`; callers must narrow on `result.dryRun` before reading
  `pipelineResult`, `init`, or `analysis`. Dry runs no longer fabricate results for stages that
  did not execute. These are intentional breaking type-shape corrections for embedders.
- LLM prompt/response diagnostics are now disabled by default, require exact
  `OPENLORE_LLM_LOGS=1` opt-in, redact secrets, and retain at most six files or 300 MB;
  local telemetry documentation now matches its exact gate and recorded event domains.
- Drift results now carry required `analyzedFiles` and `filesOmitted` receipts. The drift CLI
  reserves exit `1` for confirmed drift and uses exit `2` when the check cannot run; reinstalled
  pre-commit hooks upgrade in place, validate JSON before blocking, preserve existing hook
  failures, and allow infrastructure failures with an explicit warning.
- Interference maps now retain unassessable branches, reject unsafe base guesses,
  disclose enumeration limits/failures, and stop treating shared reads as conflicts.
- Enforcement JSON schema version 2 normalizes governance finding severity to
  `info`, `warning`, `error`, or `critical` (`warn` is now `warning`).

## [2.2.0] - 2026-08-16

**The release where OpenLore learned to show its work.**

- Generate and repair now share bounded, provenance-rich evidence across agents.
- Analysis, daemon, MCP, and bundle lifecycles are safer under concurrency and untrusted input.
- Test selection, language detection, coverage reporting, and OpenSpec change status are more accurate.
- Releases now validate and promote one immutable package artifact.

Existing v2 API consumers remain compatible; coverage availability is explicit through `mappingCoverage`.

**Upgrade:** `npm i -g openlore@2.2.0` — or `openlore update`.

**Full Changelog**: https://github.com/clay-good/OpenLore/compare/v2.1.9...v2.2.0

## [2.1.9] - 2026-08-09

**The release where OpenLore stopped trusting the vibes.**

- Import resolution got smarter, including the deeply suspicious `.tsx` and `.jsx` twins.
- Stale analysis now says it is stale instead of confidently wearing last week's nametag.
- Repository secrets, hostile prompts, and wandering viewer file reads all meet firmer boundaries.
- First-run guidance and empty results now tell you what actually happened.

Everything is backward-compatible: no commands, options, exports, or config keys were removed.

**Upgrade:** `npm i -g openlore@2.1.9` — or `openlore update`.

**Full Changelog**: https://github.com/clay-good/OpenLore/compare/v2.1.8...v2.1.9

## [2.1.8] - 2026-08-02

**The release where `analyze` stopped caring how big your repo is.**

Last time `analyze` stopped dying on one hostile *file*. This time it stops dying on
the whole *repository*, however large. Plus we closed a security advisory, and the MCP
server finally leaves when you do. Everything is additive and backward-compatible.

### Security: a spec write that could escape the project root (GHSA-5j8x-q7q6-58j5)

`openlore generate` built each spec's output path from an LLM-derived `domain` field.
Against a repository you don't trust, a crafted value could steer that write *outside*
your project root. Now the domain is normalized to a single safe path segment and every
spec write goes through the same symlink-aware root guard the rest of the codebase uses —
an out-of-root path is refused, not written. Regression tests on both the source and the
sink, plus a structural guard so a future edit can't quietly reopen the door.

### `analyze` scales to any repo size

- **No more out-of-memory on large repositories.** Repo-wide enrichment scans are bounded,
  five superlinear scans are gone, and the background index no longer grows forever.
- **The CFG overlay stays in memory and only spills to disk when it's actually big** — the
  common case never touches the filesystem.
- **Adaptive heap + graceful degradation.** `analyze` sizes its own heap to the machine
  (cgroup-aware) and, when a repo is too big for a full pass, steps down a level instead of
  falling over. Any repo finishes with *some* answer, never a crash.
- **Deep import chains no longer overflow the stack** — cycle detection is iterative now.

### The MCP server leaves when you do

The zombie-process known issue from 2.1.7 is fixed: the stdio server's lifetime is now
bound to its transport, so when your agent closes stdin, the process (and its file watcher)
exits. No more stray `openlore mcp` holding caches after the session ends.

### Honesty, still the house style

- **The walker no longer hands back a silently smaller graph.** If it can't cover the whole
  corpus it says so — with a truncation receipt — instead of quietly analyzing less.
- **Git-derived signals tell the truth** about their own window: churn is measured over a
  real pre-change window, federation claims reflect the current tree, and change detection is
  work-tree-aware.
- **`generate` preserves your existing specs** instead of clobbering them on regeneration.

### Under the hood

- Property-based fuzzing now runs against the untrusted-input surface.
- Dependency bumps: commander 15, chalk 6, ora 9, transformers 4.

### Known issues

- **A config missing its `analysis` section still crashes `analyze`** with an internal
  `TypeError` (and `doctor` still calls that config healthy). Not a regression — carried over
  from 2.1.7. If you hand-edit `.openlore/config.json`, keep the `analysis` block, or re-run
  `openlore init`.

---

**Upgrade:** `npm i -g openlore@2.1.8` — or `openlore update`.

**Full Changelog**: https://github.com/clay-good/OpenLore/compare/v2.1.7...v2.1.8

## [2.1.7] - 2026-07-26

**The release where `analyze` stopped dying and started explaining itself.**

Three things this time: analysis got faster, it got harder to crash, and — the theme —
it got much better at admitting what it *didn't* do. Everything is additive and
backward-compatible. If OpenLore has been working for you, upgrade and it keeps working.

### `openlore analyze` no longer dies on a hostile file

One 300 KB file could kill the whole run with a single line of C++ and exit code 134:

```
libc++abi: terminating due to uncaught exception of type Napi::Error
```

No stack, no error line, no artifacts, no clue which file did it. Delightful.

The culprit was a file that parsed into a tree **100,002 nodes deep**, which overflowed
the stack inside a native call — where a JavaScript `try`/`catch` can't reach. Two fixes:
the tree walk no longer uses the call stack, and every parse is now bounded by a per-file
budget (20 s, generous on purpose; the slowest real file in this repo is under a second).
A file that blows the budget is set aside and *reported*, not waited on.

Same repository, before and after: **exit 134 → exit 0**, and **217 s → 52 s**.

If you'd rather wait than be told, `OPENLORE_PARSE_BUDGET_MS=0` turns the bound off
entirely and restores the old behavior exactly.

### Fewer files skipped in silence

"Files skipped: 3" told you nothing and worried you slightly. Now it says *why*
(`pattern 2, gitignore 1`), and any file the analyzer set aside is recorded with a
machine-readable reason that `analyze`, `doctor`, and the MCP tools all read from the
same place — so they can't tell you three different stories about one repository.

While a run is going, a file that's taking unusually long gets named on stderr, so
"why is this slow" has an answer that isn't "attach a debugger."

### Analysis got quicker

- **Pass-1 extraction runs on a worker pool** — call-graph build 19.1 s → 7.3 s on this
  repo; full `analyze --no-embed` 24.6 s → 18.1 s. Byte-identical output.
- **Unchanged files aren't re-parsed.** A content-hash memo takes `--force` 45–54 s down
  to 36–39 s on a re-run.
- **Reachability is precomputed at analyze time**, so the tools that traverse it just look
  things up: coverage-gaps 346 ms → 6.4 ms (54×), test selection 575 ms → 117 ms (4.9×),
  measured at 50k nodes / 200k edges.

### Security: analyzing a repo you don't trust

OpenLore reads whatever you point it at, which means a repository can try things. Ten
findings closed against that threat model, plus a separate fix for terminal control
sequences. Highlights:

- A cloned repo's `.openlore/config.json` could redirect the LLM endpoint and switch off
  certificate verification — collecting your `ANTHROPIC_API_KEY` on your next `generate`,
  `drift`, or commit. Repo-supplied values are now ignored unless they point at loopback;
  your own `--api-base` / env vars still work, because those come from you.
- A filename could carry raw terminal escapes into OpenLore's output. A forged
  `[ok] all checks passed` is an attack, not a cosmetic glitch.
- Two regexes could be made to hang on crafted input.

Dependency and workflow scanning now run automatically in CI.

### Also

- Windows paths with backslashes no longer split incorrectly.
- Four places where a tool reported `0` for something it had never actually computed.

### Known issues

Two defects an end-to-end pass found are **not** fixed here. Both are tracked and queued for the
next release; neither is a regression from this one.

- **The MCP stdio server doesn't exit when its client closes stdin**, once a call has started the
  file watcher. Every agent session leaves a process holding a watcher and its caches. Workaround:
  kill stray `openlore mcp` processes, or use `openlore serve`, which reaps itself when idle.
- **A config missing its `analysis` section crashes `analyze`** with an internal `TypeError`, and
  `doctor` reports that same config as healthy. If you hand-edit `.openlore/config.json`, keep the
  `analysis` block — or re-run `openlore init`.

---

**Upgrade:** `npm i -g openlore@2.1.7` — or `openlore update`.


## [2.1.6] - 2026-07-19

**The boring release. We mean that as the highest compliment.**

v2.1.5 made OpenLore pleasant to start using. This one makes it hard to break. Forty-five
changes, and not one of them adds a knob you have to turn: no new required config, no tool or
command or language removed, no LLM anywhere in the serving path. What changed is that the
substrate now tells the truth more stubbornly and falls over less often — the same answers, the
same speed, fewer surprises at 2am.

A good memory is one you stop thinking about. That was the whole goal here.

Everything below is **additive and backward-compatible**. If OpenLore has been quietly working
for you, upgrade and it will keep quietly working — just with fewer sharp edges you were never
supposed to touch.

### The index looks after itself now

- **Reads can no longer destroy your index.** Opening the graph store for a read used to be able
  to drop tables on a schema mismatch; now a read is a read. A version bump rebuilds through the
  one path that owns rebuilds, a schema mismatch reports "not ready" instead of nuking your data,
  and a genuinely corrupt store gets quarantined as `*.corrupt-N` rather than silently reused.
- **Staleness heals itself.** When the read path notices the index has drifted from the code, it
  kicks off an at-most-once background repair and tells you it's doing so — instead of handing you
  stale answers with a straight face. `openlore doctor --fix` covers the rest.
- **Analysis is now deterministic.** Analyze the same commit twice and you get byte-identical
  artifacts — sampling is seeded, aggregation is order-stable. No more phantom diffs from a graph
  that couldn't make up its mind.
- **Artifact writes are atomic and locked.** Every analysis artifact is written all-or-nothing
  behind a single lock, so a crash mid-write leaves you with the old good file, never half a new
  broken one.
- **A crashing event no longer takes the daemon with it.** An async watcher/stream error is caught
  and logged instead of felling a long-lived process — the watcher survives the day.

### The graph stops fibbing about your code

A pile of parser-fidelity fixes, all in service of one thing: the call graph should describe the
code you actually wrote.

- **Route handlers stay connected.** TS/JS route lines are now masked length-preservingly instead
  of skeletonized, so route→handler edges stop drifting and handlers stop being mislabeled dead.
- **More exports are seen.** `async`, generator, `abstract`, `default async`, and `const enum`
  exports are recognized, and comment-shifted line numbers are corrected.
- **Clone detection stops crying wolf.** String-literal-aware normalization means a truncated
  literal no longer produces a false "100% identical" verdict.
- **Ambiguous calls are disclosed, not guessed.** When the resolver can't be sure which function a
  call reaches, it says so instead of confidently binding to the first match.
- **Non-ASCII filenames stop vanishing.** Every git path-listing spawn now runs with quoting off,
  so files with accents or CJK names stay in the graph.
- **Sub-word search actually matches.** Identifier-aware BM25 tokenization means searching `parse`
  finds `parseConfig`; the tokenized corpus is persisted, so cold starts are ~90% faster and the
  tokenizer stamp guards serving end-to-end. Parse-health is disclosed rather than silently
  swallowed, and language detection runs through one guarded detector.

### Secrets stay secret, servers stay closed

- **Authorization headers are fully redacted** — including the credential half of `Basic` auth —
  and a redaction cycle returns a redacted twin, never the original value it was trying to hide.
- **`serve.json` is validated at every reader** through one shared validator, with an outbound
  SSRF guard, so an untrusted descriptor can't point the daemon somewhere it shouldn't go.
- **The view server now sits behind the serve daemon's request guard**, closing the last local
  HTTP surface that wasn't protected against DNS-rebinding.
- **Node floor raised to where `node:sqlite` actually exists** — and OpenLore probes for the
  capability rather than trusting the version string.

### Governance you can trust

- **A rejected decision stays rejected.** One shared status-transition table locks every promotion
  door (MCP, API, CLI), so `sync` or `approve` can't quietly resurrect a verdict you turned down.
- **Decision autopilot** (opt-in): auto-accept governance with an append-only audit ledger, for
  teams who've decided they trust the gate.
- **The conclusion contract is enforced at dispatch** — a tool that's supposed to return an answer
  can't accidentally hand back a graph to traverse — and MCP↔Pi tool parity is guarded in both
  directions, so the two surfaces can't drift apart.
- **Federation degrades gracefully:** an empty fingerprint is baselined at first sight and a
  corrupt registry degrades instead of blocking, so a half-set-up peer never wedges the fleet.

### CLI & config, cleaned up

- **`--config` is finally honored** — an explicit config path is actually read, and it's fatal if
  it's wrong rather than silently ignored.
- **`.openlore/config.json` is validated:** typo'd keys get a did-you-mean, type mismatches and
  version skew are disclosed (diagnostics go to stderr, so machine-readable output stays clean).
- **Uniform output across every command:** one color layer, honest summaries, one vocabulary, and
  base-refs that resolve-or-disclose instead of silently falling back to `main`.
- **Install detection is evidence-based** — OpenLore figures out how it was installed and never
  mutates the wrong (e.g. global vs local) install.
- **`openlore serve` now reports the same `substrate` default (13 tools) as `openlore mcp`**, and
  every help string, docstring, and doc entry names that one default through a single constant
  (change `fix-default-preset-claims`). Pass `--preset navigation` for the lean 10-tool surface.

### New this release

- **`locate_symbol_span`** — a read-only, staleness-checked "where does this symbol live right
  now" lookup a host can trust before it edits (fresh / stale / ambiguous / not-found, never a
  confident wrong line).

### Under the hood

- Specs refreshed to match the current architecture; shipped-change statuses reconciled with git
  reality; quantitative doc claims (language counts, the test floor) are now pinned to code by a
  guard test. The epistemic-lease weight table is complete and bound to the registry. `tree-sitter-c-sharp`
  is pinned to the ABI-matching `^0.21.3`. Assorted test-suite flakes defused.

The version is read from `package.json`, so `--version` and the `tools/list` banner track this
bump automatically — nothing to configure.

## [2.1.5] - 2026-06-28

**Happy-path polish + the benchmark-cleared `substrate` default** (PR #218, change
`refine-happy-path-and-defaults`). This release raises the *first-five-minutes / first-five-tool-calls*
quality of OpenLore to the level of its capability: it makes opt-in features discoverable, the CLI and
tool surface legible, first use honest, and verbose output economical — and, on a benchmark run across
two models and both repo tiers, flips the default MCP surface to the both-faces `substrate` preset.

Everything is **additive and backward-compatible** — no tool, command, preset, language, or capability
removed; no required config added; deterministic and local-first (no LLM in any serving path). The two
behavior changes below each ship with a one-flag/one-param escape, so callers that want the prior
behavior keep it. The runtime version is read from `package.json`, so `--version` and the `tools/list`
banner track this bump automatically.

### Changed

- **Default MCP surface is now the `substrate` preset (13 tools, both faces)** — flipped from the
  10-tool `navigation` preset. A default `openlore install` / bare `openlore mcp` now exposes the
  navigation graph-traversal core **plus** the three highest-value governance reads (`recall`,
  `verify_claim`, `blast_radius`), so an agent is both-faced out of the box. The flip cleared the
  `DefaultSurfaceRevealsAllFaces` gate: deterministic token economy (~4.5k tokens, +1.2k over
  navigation, within the ~10k tool-search threshold) and face coverage, **plus** an agent benchmark via
  the Claude Code CLI — selection accuracy (substrate 90% vs navigation 80% shared, 100% vs 0%
  governance) and end-to-end task completion across **two models (sonnet + the weaker haiku) and both
  repo tiers** (100% correctness everywhere, no regression, substrate cheaper on 3 of 4 cells). Recorded
  as decision `c79ec7ca` / **ADR-0023, superseding ADR-0022**. **Escape:** `--preset navigation`
  restores the lean navigate-only core; `--preset full` still wires all 72 tools.
- **Verbose tools are concise by default** (`ConciseByDefaultDetailedOnRequest`) — `get_duplicate_report`
  and the four list inventories (`get_middleware_inventory`, `get_schema_inventory`,
  `get_ui_component_inventory`, `get_env_vars`) now return a concise summary (totals + a sample + a
  truncation receipt naming the fuller call) instead of the full payload. Measured **−87%**
  (`get_duplicate_report`) and **−45%** (`get_env_vars`) on this repo; small inventories return in full
  (no data lost). **Escape:** `responseFormat: "detailed"` returns the complete payload.
- **`get_ui_components` → `get_ui_component_inventory`** — renamed for consistency with its
  `get_*_inventory` siblings. The prior name keeps working forever as a permanent deprecated **alias**;
  no caller breaks.

### Added

- **`openlore features`** — lists every opt-in feature (embeddings, covering surfaces, enforcement
  policy, panic, spec store, federation, …), whether each is active, and the one command/snippet to turn
  it on. Answers "where do I turn on X?" with zero required config. `--json`, `--inactive`.
- **Job-grouped `openlore --help`** — the ~49 commands are grouped by job (set up · navigate · govern ·
  inspect · multi-repo · advanced/experimental) instead of one flat list; nothing is hidden.
- **Structured ready-or-honest first use** — a graph tool invoked before the index exists returns a
  machine-readable `{ notReady, reason, remedy }` (or self-bootstraps) instead of a silently-empty
  result, so an agent never mistakes "no index" for "no findings."
- **Documentation index** — `docs/README.md` maps a task to the one canonical page; overlapping pages
  cross-link to their canonical source; stale pages carry redirect banners.
- **Preset benchmark harnesses** — `npm run bench:surface` / `bench:selection` / `bench:completion`
  (deterministic + Claude Code CLI) reproduce the default-flip evidence; `bench-agent.ts` gains additive
  `--results-json` / `--with-only` hooks.

### Notes

- `ProgressiveCatalogDisclosure` is satisfied by the shipped server-side design (preset fallback +
  per-tool `annotations.family`). Native `defer_loading` / Tool Search is a client/API responsibility an
  MCP server cannot emit, and the server-side `list_changed` alternative was rejected because it
  invalidates the prompt cache the requirement asks to preserve.

## [2.1.4] - 2026-06-27

The largest release since v2.1.2: everything merged since the `v2.1.3` tag (PRs #183–#216) plus the
**capability-family taxonomy + `substrate` preset + `openlore mcp --list-tools`** and the
behavior-preserving **call-graph modularization** (PR #217). All changes are **additive and
backward-compatible** — no breaking changes to tools, schemas, or stored data — and **deterministic and
local-first** (no LLM in any serving path), per the north-star decision `c6d1ad07`. The CLI and the MCP
server read the version from `package.json`, so both report `2.1.4`.

### Added

- **Capability-family taxonomy + `substrate` preset + `openlore mcp --list-tools`** (PR #217;
  change `unify-navigation-and-governance-substrate`) — names what OpenLore already is: **one
  structural substrate with two faces** — a *read* face that navigates the graph and a *write/check*
  face that anchors facts and weighs changes — not two products. Every one of the **72** MCP tools now
  declares exactly one of six **closed capability families** — `navigate` · `change` · `remember` ·
  `verify` · `coordinate` · `federate` — surfaced in each tool's MCP `annotations.family`, so a wide
  surface stays discoverable by family instead of a flat list of 72 names. A new **`substrate` preset**
  spans both faces out of the box — the `navigation` graph-traversal core plus the three highest-value
  governance *reads* (`recall`, `verify_claim`, `blast_radius`). Per ADR-0022's evidence rule the
  **active default stays `navigation`** until an agent benchmark clears the wider one; `substrate` ships
  as a selectable preset. New **`openlore mcp --list-tools`** prints the active surface grouped by
  family. Adjacent tools that answer genuinely distinct questions now cross-reference each other in
  their descriptions (`NoRedundantConclusions`), and `tool-contract.test.ts` fails CI if a tool forgets
  a family or an adjacent tool drops its sibling reference. **No new tool, dependency, LLM, or persisted
  artifact.** Reference: `openspec/changes/unify-navigation-and-governance-substrate/`.

- **Codebase style fingerprint — `get_style_fingerprint`** (STRUCTURAL-CONTEXT-PATTERNS proposal 1) —
  a **descriptive, deterministic per-language idiom profile** so an agent matches the house style
  instead of its training-prior default. During the *existing* tree-sitter walk (no second parse, no
  LLM) the analyzer tallies a fixed, closed set of idiom counters — function form (arrow / declaration
  / method), binding (`const` / `let`; Go `:=` / `var`), conditional (ternary / `if`), async (`await` /
  `.then`), string (template / concatenation), function-naming case — and rolls them up to the
  repository, each community/region, and (on request) a single file, each reported as
  `{ dominant, ratio, samples }`. **Honest by construction**: a counter below a fixed evidence floor
  reports a null signal, and a choice the language/formatter *enforces* (Go ties identifier case to
  visibility) reports `enforced` rather than a tautological `1.0`. **Descriptive, not prescriptive** —
  no lint judgment, no composite style score. Persisted as its own `style-fingerprint.json` (the hot
  `llm-context.json` stays lean) and incrementally refreshed under the watcher. `orient` also carries a
  compact `regionStyle` line for the touched region, and the `get_language_support` matrix now derives
  the `styleFingerprint` capability from the live extractor set (TypeScript/JavaScript/Python/Go).
  Opt-in `get_style_fingerprint` MCP conclusion tool (`--preset full`, not the lean default) and the
  `openlore style-fingerprint` CLI (read-only, never blocks). Full surface count 67 → 68. Reference:
  `openspec/changes/add-codebase-style-fingerprint/`.

- **Public API surface contract — `certify_public_surface`** (FEATURE-UPDATES proposal 2) — certify
  whether a working-tree diff breaks the package's exported contract. With no base ref the tool returns
  the **public surface** (exported symbols + signatures); with a base ref it returns a deterministic
  **breaking-change verdict** — each changed export classified `breaking` / `non-breaking` /
  `potentially-breaking` (removed/renamed export, added required param, narrowed param/return type,
  reduced visibility), each breaking one paired with the **in-repo consumers it breaks**, plus an
  overall summary. **Conservative by construction**: a change it cannot *prove* compatible is
  `potentially-breaking`, never silently safe — no type checker, no build. A renamed export is reported
  as a rename (not remove+add) via symbol-identity continuity; external/unindexed consumers are
  disclosed as a known-unknowable boundary. Signature classification covers TypeScript/JavaScript/Python
  (others fail-soft to surface membership). Distinct from `change_impact_certificate` (paths *into* a
  surface) — this certifies the exported contract's *shape*. Opt-in `certify_public_surface` MCP
  conclusion tool (`--preset full`, not the lean default) and the `openlore certify-public-surface` CLI
  (read-only, never blocks). Full surface count 66 → 67. Reference:
  `openspec/changes/add-public-api-surface-contract/`.

- **Symbol identity continuity — memory survives renames & moves** (FEATURE-UPDATES proposal 1) — a
  renamed or moved symbol no longer orphans the memories and decisions anchored to it. At each
  `openlore analyze`, OpenLore snapshots the prior graph, detects symbols that disappeared (anchored,
  now-unresolved) and appeared (new), and **carries the anchors forward** to the new symbol with
  `carriedAcross: { from, reason, basis, atCommit }` provenance — turning a silent `orphaned` into a
  `fresh`/`drifted (carried)` recall that `recall` surfaces with the provenance. Matching is deliberately
  conservative and threshold-free: `exact-body` (byte-identical span — a pure move) or `exact-signature`
  (the body is identical *modulo the symbol's own name* — a rename, verified by substituting the new name
  back to the old and checking the recorded baseline hash), admitted only on a strict one-to-one match
  and only when the name-independent body is unique among new symbols. A genuinely deleted symbol is
  **never** re-anchored onto an unrelated newcomer that merely shares a parameter shape; an ambiguous move
  stays orphaned and discloses `possiblyMovedTo: [...]` candidates instead of guessing. Test symbols are
  never carry targets. The anchor's `contentHash` baseline is preserved, so the existing freshness engine
  remains the single source of truth. No graph-schema change, no new MCP tool, no LLM, no clock; new
  anchor fields are additive (legacy stores load without migration). Trigger is full `analyze` (the
  incremental-watcher path is a deferred follow-up). Reference:
  `openspec/changes/add-symbol-identity-continuity/`.

- **Call resolution recall — re-export / barrel resolution** (FEATURE-UPDATES proposal 4) — the import
  resolver now follows re-export chains (`export { x } from`, `export * from`, and the TS ESM
  `.js`-specifier forms) through any depth of barrel to a symbol's **true definition**, and that
  re-export-aware map is **threaded into call-edge resolution** (Pass 2), which production builds never
  did before — so a cross-file call resolves to its real target at `import` confidence (or the new
  `re_export` confidence when a barrel hop was followed) instead of falling through to the ambiguous
  first-same-named-candidate (`name_only`). Cycle-detected and depth-bounded; gated to `imports`-capable
  languages; fail-soft. Strictly additive: when no re-export applies the result is identical to the direct
  target, and directly-resolved edges (`same_file`/`self_cls`/`type_inference`) are never dropped or
  downgraded. **Dogfood on this repo:** ambiguous `name_only` call edges fell 1067 → 87 (−92%), precise
  cross-file edges rose 0 → 1326 `import` + 21 `re_export`, unresolved `external` fell 8742 → 8563, and
  **29 symbols moved off the false-dead / false-entry-point list** (e.g. `EdgeStore.open`, reported as
  having zero callers, recovered its real 22) — raising the soundness floor under every reachability
  conclusion (`find_dead_code`, `select_tests`, `analyze_impact`, `blast_radius`,
  `report_coverage_gaps`) at once. The resolved map is also threaded into the **incremental watcher**
  (new `collectReExportBarrels` pulls barrel files into the subset for export-indexing only), so an
  incremental rebuild converges to `analyze --force` on barrel edges instead of degrading them to
  `name_only` (parity oracle Scenario 4). **Python relative imports now resolve too:** the leading-dot
  module form (`from .impl import x`, `from ..pkg.mod import y`) is resolved to the true file, and
  function-level (deferred / cycle-breaking) imports are captured — dogfooding a real Python repo this
  took precise cross-file `import` edges from 0 → 102 and cut ambiguous `name_only` from 156 → 58,
  making the registry's Python `imports` capability functional. A structural audit during
  implementation found the proposal's other edge classes — interface→implementation, override, and
  single-implementor dispatch (items 2/3) — **already delivered** by the shipped CHA pass
  (`add-type-hierarchy-resolved-dispatch`); they are cross-referenced, not re-implemented. No graph-schema
  change, no new MCP tool, no LLM. Reference: `openspec/changes/add-call-resolution-recall/`.

- **Structural test-coverage gaps + `report_coverage_gaps`** (FEATURE-UPDATES proposal 5) — a
  deterministic, graph-derived report of important code with **no reaching test**, ranked by
  `hub`/`chokepoint` significance. It is the structural **inverse** of `select_tests`: seed on every
  test node plus the production side of every `tested_by` association, forward-reach to the
  test-reachable set, and report the internal code outside it (test/generated/vendored/`.d.ts`
  excluded). No test run, no coverage instrumentation, no runtime, no LLM — the graph already encodes
  the answer. **Gaps-only and honest:** it reports "no reaching test" and never claims a symbol is
  "tested" (reachable-from-a-test is not behavior-verified); a gap with no caller at all is labeled
  *also-dead* (distinct from `find_dead_code`), an untested entry point is *untested-not-dead*, a scope
  that resolves to nothing is disclosed (never a reassuring "0 gaps"), scoped counts range over the
  in-scope set, and a stale/degraded index is surfaced in the human view (a degraded index manufactures
  false gaps). Ranking uses labels + raw evidence — no composite score, no tuning constant. Scope to a
  diff (`changedSymbols`/`diffRef`) or a region (`filePattern`); `directResolvedOnly` for a stricter
  (more gaps, more certain) report whose also-dead labeling shares the gap basis. Two surfaces: the
  opt-in `report_coverage_gaps` MCP conclusion tool (`--preset full`, not the lean default) and the
  `openlore coverage-gaps` CLI (read-only, never blocks). Distinct from `get_test_coverage` (spec-tag
  based). Full surface count 65 → 66. Reference: `docs/coverage-gaps.md`.

- **Declarative language-support registry + `get_language_support`** — the per-language knowledge
  OpenLore already encodes (call-graph extractor, CFG `SPECS` table, signature extractor, type-inference
  engine, IaC projector) is now consolidated behind one declarative capability registry
  (`src/core/analyzer/language-support.ts`), and per-language coverage is observable. Capabilities:
  `signatures`, `callGraph`, `imports`, `cfgOverlay`, `typeInference`, `styleFingerprint`,
  `iacProjection`. The registry is **derived** from the live extractor structures (not hand-listed), so
  the coverage matrix cannot silently over-claim — a behavioral test cross-checks every cell against the
  real extractor (every member of every capability set, including each `IAC_LANGUAGES` ecosystem run
  through the real analyze pipeline, plus an exact predicate assertion for `cfgOverlay`/`iacProjection`). Two
  surfaces: a **Language coverage** matrix in `.openlore/analysis/CODEBASE.md`, and the opt-in
  `get_language_support` MCP conclusion tool (repo-detected languages, or a named language as a pure
  registry lookup — fail-soft for unknown languages). Makes a quiet structural result interpretable
  ("calls unsupported for L" vs. "no callers"). No extraction-output change, no new dependency, no LLM.
  Full surface count 64 → 65. Canonical reference + "add a language" checklist: `docs/language-support.md`.

- **`map_in_flight_conflicts` — cross-actor interference map** (PARALLEL-WORK proposal 4). The team
  version of `plan_parallel_work`: instead of a caller-supplied task list it harvests every change in
  flight — local branches (git), open PRs (`gh`), and any supplied agent task descriptors — as
  actor-attributed nodes and runs the shared hazard classifier across all of them. Each footprint is
  derived from the change's ACTUAL diff: hunks map to the enclosing symbols of a re-parsed base
  snapshot, and the per-symbol `writeMode` is read off the hunks (`append` iff pure-insertion, else
  `modify`), so two PRs appending disjoint entries to the same dispatcher resolve to `shared-append`,
  not a false WAW — with no `writeMode` declaration. A change whose diff can't be fetched or whose
  symbols don't resolve is labeled "not assessed", never a false "no conflict". Read-only and stateless
  (no watcher/poll/persisted store); opt-in `federation` matches in-flight changes across repository
  boundaries by content-addressed stable id. Advisory; WAW pairs emit the policy-governable
  `cross-actor-conflict` finding a CI check can gate on. In the opt-in `coordination` and `federation`
  presets (not the lean default). Full surface count 63 → 64.

- **Index integrity attestation** — `analyze` now writes `.openlore/analysis/index-attestation.json`
  (schema version, committed production counts, content digest) deterministically. On load the
  persisted graph index is reconciled against it into a `healthy | degraded | mismatched` verdict:
  a schema-version drift is `mismatched`; a store materially smaller than the build committed (after a
  WAL checkpoint-and-recount retry, with a small-repo exemption) is `degraded`. A non-healthy index is
  never silently served — it emits a recoverable signal, surfaces on `get_health_map` as
  `indexIntegrity`, and rides the `confidenceBoundary.integrity` of `find_dead_code` / `select_tests` /
  `analyze_impact` / path tracing so a negative conclusion over a broken index is labeled
  (`complete: false`) rather than asserted. The incremental watcher keeps the attestation's counts in
  lockstep so ordinary editing never false-flags `degraded`. Advisory by default; deterministic, no LLM,
  no new MCP tool. Extends the "never present absence as current fact" store ethos to the graph index.
- **`verify_claim` `decision-current` kind** — verify a recorded decision is still
  authoritative before an agent cites it to a human ("decision X governs this, so it's
  safe"). `subject` is an 8-char decision id; the verdict is `confirmed` (recorded, not
  superseded, not rejected), `refuted` (superseded — naming the live superseder to cite
  instead — or rejected), or `unverifiable` (unknown/malformed id). It reads the same
  decision-store retirement graph the `stale-decision-reference` finding walks, so the
  active (`verify_claim`) and passive (`recall` / `openlore enforce`) surfaces can never
  disagree, and it does not touch the structural call-graph verifier. No new MCP tool
  (stays in the opt-in `verify` preset); deterministic, no LLM. Closes the deferred
  `verify_claim` clause of the finding-enforcement-policy change.

- **Unified finding-enforcement policy** — a single `enforcement.policy` block in
  `.openlore/config.json` maps a stable governance finding `code` to one enforcement
  class (`blocking | advisory | off`), decoupling a finding's intrinsic severity
  (owned by its source) from the repository's risk posture. The new `openlore enforce`
  gate collects findings from every in-scope source, resolves each through the single
  policy, and in `--hook` mode blocks the commit only on a `blocking`-classed finding
  (advisory by default; `off` findings stay visible, never invisible). The legacy
  `blastRadius.block` / `impactCertificate.block` configs lower onto it (a direct
  policy entry wins). Adds the deterministic `stale-decision-reference` finding — a
  live, authoritative artifact (approved decision / non-orphaned anchored memory /
  spec requirement) that still cites a superseded decision — also surfaced as a
  `staleDecisionRef` signal on the `recall` MCP tool's output. No new MCP tool;
  deterministic, no LLM. Flags: `--hook`, `--install-hook`, `--uninstall-hook`,
  `--json`, `--base`.
- **`openlore review` — deterministic structural PR review (#188).** A new no-LLM CLI
  command that composes the structural delta (`structural_diff`: removed/added/
  signature-changed symbols + the callers they leave stale) and the blast radius
  (`computeBlastRadius`: hubs, layers, tests to run, and the spec/memory/decision drift
  the change introduces) for a `base..head` range into one conclusion-shaped Markdown or
  JSON briefing. No new MCP tool, no new structural computation. Ships with a bundled
  GitHub Action (`.github/actions/openlore-review`) that posts it as a single sticky PR
  comment — created once, updated in place by a hidden marker, never duplicated — plus a
  copy-paste workflow. Advisory by default (exit 0); opt-in gating via the existing
  `blastRadius.block` convention. Degrades honestly (no index → structural delta only +
  "run `openlore analyze`"; non-git / unreachable base / unwritable `--out` disclosed,
  never a crash). The Action activates once a published `openlore` ships `review`.
- **OpenSpec plugin manifest (marketplace Phase 1)** — OpenLore is the inaugural
  OpenSpec marketplace plugin. It now ships a declarative plugin manifest (the
  `"openspec"` key in `package.json`, vendored schema
  `schemas/openspec-plugin-manifest-v1.json`) that OpenSpec reads to discover,
  surface, gate, and invoke OpenLore as a subprocess without importing its code.
  New `openlore plugin-manifest emit|validate` inspects/validates it — named
  distinctly from the federation `openlore manifest` so the two never collide. The
  host loader and curated registry are built separately in the OpenSpec repo.
- **Task-scoped context injection** — `openlore install` now wires a Claude Code
  `UserPromptSubmit` hook running `openlore orient --inject`, which orients on your
  submitted prompt and injects a bounded, deterministic, ignorable orientation
  block *before the agent's first turn* — amortizing the per-task `orient`
  round-trip the Value Scorecard attributes the small/familiar loss case to. A
  deterministic relevance gate keeps it out of weak/shallow tasks (degrading to a
  one-line pointer); it is fail-open (never breaks a turn) and reuses the lean
  `orient` output (no new MCP tool). Disable or tune via the `contextInjection`
  block in `.openlore/config.json` (`mode: "off"`, `tokenBudget`, gate thresholds).
  Adapters without a pre-turn hook (Cursor/Cline/Continue/AGENTS.md) fall back to
  the instruction block (#184).

### Changed

- **Call-graph builder modularized behind a stable barrel** (PR #217; change
  `modularize-call-graph-builder`) — `src/core/analyzer/call-graph.ts` (the repo's most-imported file,
  ~155 importers) was **5,425 → 4,745 lines**, decomposed into six cohesive sibling modules
  (`call-graph-types`, `-extract`, `-external`, `-complexity`, `-cfg`, `-builtins`). **`call-graph.ts`
  re-exports every previously-importable name**, so none of the 155 importers moved and the public
  import surface is byte-for-byte identical (23 exported names, 0 added/removed). Each extraction was
  verified **byte-identical** by a graph+helper snapshot oracle (and the full analyzer suite), so graph
  output is unchanged. A `stable call-graph barrel` test locks the invariant. The remaining
  higher-coupling sections (dispatch-synthesis, grammar loading, the attribution hub) are intentionally
  deferred/out-of-scope — see the proposal for the value-vs-risk rationale. Pure internal hygiene: no
  feature, dependency, LLM, or persisted artifact.

- **CLI front door now describes the product and steers to one-command setup.**
  Bare `openlore` / `openlore --help` previously opened with the legacy spec-gen
  framing ("Reverse-engineer OpenSpec specifications…") and a Quick start that sent
  new users to `openlore generate` (LLM/API-key-gated). The program description now
  reads "Persistent architectural memory for coding agents" (served via `orient` +
  MCP), the `--help` epilog leads with "Get started (one command): `openlore install`"
  and groups commands into no-API-key **Core** vs optional **Spec authoring**, the
  stale `test` line now reads "Report spec test coverage" (it never generated tests),
  and `openlore doctor` recommends `openlore install` when config/analysis is missing.
  `openlore install` and `openlore doctor` are documented in the CLI reference (#188).

- **The default MCP tool surface is now lean (behavior change).** A bare
  `openlore mcp` and a plain `openlore install` now wire the 10-tool `navigation`
  preset — the Spec 14 benchmark-winning graph-traversal core — instead of all 62
  tools. Schemas for tools the agent never calls are pure per-request overhead, so
  breadth is now opt-in. The full 62-tool surface is one explicit selector away:
  `openlore mcp --preset full` / `--all-tools`, or `openlore install --preset full`.
  No tool was removed; every capability stays reachable via its named preset
  (`minimal`, `memory`, `verify`, `federation`, `full`). When the lean default is
  active, the server advertises the opt-in once through the MCP `initialize`
  `instructions` channel (zero extra tool schemas). `openlore serve` now also
  accepts `full` as an alias of `all`, and `openlore install` / `connect` accept
  `--all-tools` (#185).

  **Migration — repos that gate commits.** The lean default does **not** include the
  governance tools the decisions pre-commit gate uses (`record_decision`,
  `check_spec_drift`, `detect_changes`). If you rely on that workflow, re-install
  with `openlore install --preset full` (all 62) or `--preset minimal` (the
  governance core) to wire them back.
- **Config-key ownership** — when OpenSpec owns `openspec/config.yaml`, OpenLore now
  writes only its `openlore` key and preserves every other key and comment
  byte-for-byte (a top-level-block string splice that keeps CRLF line endings,
  inline-comment spacing, and folded scalars intact); it refuses to overwrite a
  malformed host config rather than risk clobbering it.

### Fixed

- **`openlore orient "<task>"` now honors a bare positional task.** Previously only `--task` was read,
  so the most natural invocation — a positional task — silently fell through to the no-task session
  primer and exited `0`, doing no orientation (and a stray `--limit` went unvalidated). A positional
  task is now accepted (`--task` still wins if both are given); with no task, the install SessionStart
  hook's `orient --json` still prints the primer, unchanged. (v2.1.4 pre-release QA dogfood.)
- **Same-named nested functions no longer collapse into one call-graph node.** Two `function helper(){}`
  in different methods, two `const cleanup = () => {}` arrows in one function, or a nested function
  colliding with a same-named top-level one previously shared one id and were merged at id aggregation
  (last-write-wins) — one real function was silently dropped and its edges/fan-in/out folded into the
  survivor. Pre-existing across every language; it surfaced while making `this.method()` resolution
  load-bearing. Fixed for both the dedicated extractors (TS/JS, Python, Go, Rust, Ruby, Java, C++,
  Swift, Dart, Elixir) and the shared query-spec extractor (C#, Kotlin, Scala, PHP, Lua) — whose
  extraction-time overload-dedup no longer drops a genuinely nested twin before disambiguation, so C#/
  Kotlin/Scala nested functions split too (true overloads still collapse). A genuinely nested function
  (byte-contained in another function node with a *different* id) now gets a stable, scope-qualified id
  derived from its enclosing scope — `file::A.m1/helper`, with
  a document-order ordinal `…/helper#2` for same-scope twins — never a byte offset, so it is **not**
  reported removed-and-re-added by `structural_diff` / `change_impact_certificate` when unrelated code
  shifts. Intentional collapses are preserved: an `export function` / decorated-definition wrapper
  (a same-id container = the same function matched twice) and sibling collisions (re-assigned members,
  same-file container homonyms) stay one node. The re-keyed node also carries its **CFG overlay** with
  it (collected by start byte, re-attached to the final id), so `analyze_error_propagation` / def-use
  resolve a nested function's control flow by its node id with no last-write-wins loss or orphaned
  overlay. Incoming calls resolve by **lexical scope** — a method's `validate()` binds to its OWN nested
  twin and a recursive nested `visit(){ … visit() … }` recurses to itself, instead of every incoming
  call misrouting to whichever twin sorts first (verified end-to-end: `analyze_error_propagation` on
  `processB` now reports its own `TypeError`, not `processA`'s `RangeError`; real-repo `cfg.ts` recursive
  twins drop cross-scope misroutes 7→0). Internal to the call-graph builder — no new MCP tool, no new
  CLI command, surface count unchanged. Dogfooded on the OpenLore repo (e.g. two `cleanup` arrows in
  `startMcpServer`, two `getDiff` arrows in `extractFromDiff` now resolve distinctly) — a handful
  repo-wide, no churn elsewhere.
  Reference: `openspec/changes/add-stable-nested-function-identity/`.

- **`--json` / large CLI output is no longer truncated when piped.** `process.stdout` is asynchronous on
  a pipe (the normal case when an agent or shell captures `openlore … --json`), so a command that wrote a
  large payload and then `process.exit()`ed lost everything past the ~64KB pipe buffer — e.g.
  `openlore review --format json` on a real repo emitted a 100KB briefing that arrived truncated to
  exactly 65536 bytes and failed to parse (it was fine when redirected to a file, where writes are
  synchronous — so the bug only bit the pipe path agents actually use). A new `writeStdout` helper
  (`src/cli/output.ts`) resolves only after the write has flushed; the JSON-emitting CLIs (`review`,
  `coverage-gaps`, `blast-radius`, `impact-certificate`, `working-set`, `spec-store`, `audit`, `enforce`)
  await it before exiting. Found by the full-product dogfood/`--json` purity sweep.

- **HTML inline-script extraction is now truly linear on unterminated `<script>` tags.** A file full of
  unterminated `<script` open tags drove `extractHtmlScripts` into O(N²) — each open tag re-scanned to
  EOF for a close tag that never came — so a large/generated HTML file could stall `analyze` (measured
  ~24s on 100k tags; the existing "no quadratic scan" guard was too small to catch it and intermittently
  flaked CI instead). Once the close-tag search returns "none from here to EOF", no later open tag can
  have one either, so the scan now stops — restoring O(N) (100k tags: ~24s → ~17ms). Found by the
  full-product dogfood/CI pass.

- **Provenance `gh` enrichment can no longer hang or flake CI.** `enrichWithGh` short-circuits to
  the empty map when the path is not a git repository (a non-git dir can have no GitHub remote, so
  there is nothing to enrich), and bounds the `gh pr list` subprocess with a hard 10s timeout. This
  honors the documented "best-effort, never required" contract — a stalled or absent `gh` degrades
  gracefully instead of blocking analyze — and removes a flaky 5s test timeout in CI where the
  graceful-degradation test occasionally spawned a slow `gh` in a remote-less temp dir.

- **Incremental watch now converges with `analyze --force` (substrate correctness).**
  With `--watch-auto`, each save re-resolves the changed file's reverse-dependency
  closure — its direct callers (no longer capped at 10) plus prior non-callers whose
  previously-unresolved calls a newly-added symbol now binds — so the affected call
  graph matches a full re-analyze instead of silently diverging (it was depth-1 only:
  `A→B→C`, edit `C`, callers past the first 10 and newly-resolvable non-callers stayed
  stale until the next `analyze --force`). A bounded per-save work budget
  (`INCREMENTAL_CLOSURE_BUDGET`, default 40) keeps a hub edit light; over-budget or
  unreadable files are marked **explicitly stale** in the graph metadata (freshness
  verdicts over their symbols report non-authoritative, never silently wrong) and
  self-heal as later edits touch them. A full `openlore analyze --force` clears the
  region. Name resolution for duplicate simple names is now deterministic
  (seed-order-independent), so incremental and from-scratch builds agree. The
  call-graph store gains an additive `edges(callee_name)` index (keeps the new
  closure lookups sub-millisecond instead of full table scans) and a
  `busy_timeout` (a watcher save and a concurrent `analyze --force` no longer
  throw `database is locked`). A stale-region freshness downgrade is now labeled
  distinctly (`staleRegion`) and the drift detector no longer reports it as a
  code change — the anchored code is byte-identical and it self-heals.
- **Node-version guard** — launching the CLI under an unsupported Node (<22.5) now
  fails fast with one legible stderr line and the stable exit code 78 (never a
  stack trace), protecting subprocess delegation from a host on Node 20/21. The
  guard runs from a bootstrap module so it evaluates before commander loads.
- **`--json` stream purity** — `verify --json` (and, defensively, `drift`/`decisions`
  `--json`) now keep stdout pure: machine output on stdout, all logs on stderr.
- **`openlore install --no-analyze` next-step** — it skips `init` as well as
  `analyze`, so the old advice "Run `openlore analyze`" failed with "Run `openlore
  init` first." It now advises `openlore init && openlore analyze` (or `openlore
  install` to do it in one step) (#188).
- **No-key error surfaces the `claude-code` provider** — `generate` / `run` without an
  API key previously told the user only to set `ANTHROPIC_API_KEY`/etc., never
  mentioning that the Claude Code CLI (which `openlore doctor` detects) is a no-key
  provider. The error now points to `generation.provider: "claude-code"` (#188).

**Full Changelog**: https://github.com/clay-good/OpenLore/compare/v2.1.3...v2.1.4

## [2.1.3] - 2026-06-22

Everything merged since v2.1.2: a batch of new agent-facing capabilities plus a
deep end-to-end hardening and dogfooding pass. The version is read from
`package.json`, so the CLI and the MCP server both report `2.1.3`.

### Added

- **Agent behavioral governance ("panic")** — opt-in, off by default (#175). A
  PreToolUse destabilization guard (`openlore panic-check`), an observe→memory
  feedback loop that feeds behavioral hotspots into `orient`, an optional Gryph
  runtime observer, and an accuracy-validation harness
  (`panic-validate` / `panic-calibrate` / `panic-replay`). Enable per project with
  `openlore setup --panic <mode>` and install the hooks with
  `openlore setup --hooks <format>` (remove them with `--hooks none`).
- **External spec-store binding** — the `spec_store_status` MCP tool (federation
  preset) reports the read-only health of a `.openlore/config.json` `specStore`
  binding and its indexed targets (#178).
- **Working-set context briefing** — the `working_set_context` MCP tool assembles
  one token-budgeted, per-target structural briefing for an active change across
  its spec-store targets (#180).
- **Change-impact certificate** — the `change_impact_certificate` MCP tool and the
  `openlore impact-certificate` CLI certify what a diff touches: the paths it
  newly opens into declared covering surfaces (differential, no LLM), blast
  radius, drifted specs, and the tests to run (#181).
- **Live dependency graph in watch mode** — `watch` now reconciles file creates &
  deletes and keeps `dependency-graph.json` import edges (including inline
  `<script>` and HTML asset edges) fresh incrementally (#173).
- **Pi extension** — marketplace gallery preview image (#174); Windows daemon
  hardening so no console window flashes (#177).

### Changed

- Removed the `get_decisions` MCP tool. ADRs are now surfaced through
  `search_specs` (domain `decisions`) and via `orient`'s ADR matches, which now
  work without an embedding server (#179).
- `.mjs` / `.cjs` / `.mts` / `.cts` files are now recognized as JavaScript /
  TypeScript and included in the call graph and signature index (previously
  silently dropped).
- Panic-state: the on-disk file is the single source of truth for the
  cross-process intervention counter; all writers (MCP server, hook, daemon)
  serialize through one lock.
- Documentation: Windows setup steps in CONTRIBUTING (#176); corrected and guarded
  MCP tool-count references.

### Fixed

End-to-end hardening pass (PR #182), all with regression tests:

- **First run** — `openlore init` and `openlore run` now create `.gitignore` on a
  fresh `git init` repo, so `.openlore/` analysis artifacts (multi-MB lance
  binaries) aren't accidentally committed and don't pollute diff-based tools.
- **MCP no-throw / robustness** — `get_spec` confines its `domain` argument
  (path-traversal fix); `get_file_dependencies` guards a partial dependency-graph
  artifact; `change_impact_certificate` drops non-object surface members and
  `buildLeaseAnchors` never escapes the handler; a malformed `callGraph` is
  normalized instead of crashing graph handlers; large tool results stay valid
  JSON when capped to the byte budget.
- **LLM generation** — all providers tolerate malformed or `usage`-less responses
  (common with OpenAI-compatible gateways) instead of crashing or reporting `$NaN`
  cost.
- **Panic** — fixed a cross-process lost-update on the intervention counter;
  untrusted `panic-state.json` fields are sanitized and a NaN timestamp is treated
  as expired; panic hooks gained an uninstall path and update in place on a format
  change.
- **Multi-repo federation** — a registered repo that throws mid-query is skipped
  with a reason instead of aborting the whole fleet query; tool output no longer
  leaks absolute host paths.
- **CLI** — `verify --json` and `decisions --sync` now exit non-zero on failure
  (they previously reported failure but exited 0, defeating CI gates); `decisions`
  has a top-level error boundary; `openlore view` reports a friendly message on a
  port-in-use, sanitizes errors before logging, and serves a 404 (not 500) for a
  missing graph artifact.

**Full Changelog**: https://github.com/clay-good/OpenLore/compare/v2.1.2...v2.1.3
