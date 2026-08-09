# Widen import-precise cross-file resolution beyond TS/JS/Python

> Status: PROPOSED (2026-07-03, e2e audit). Raises an existing, working claim: cross-file call
> resolution is import-precise for TypeScript/JavaScript/Python and name-based (`name_only`) for
> the other 15 callGraph languages — documented, conformance-asserted, honest. This change widens
> the import-precise set in staged, highest-value-first increments (Go first), so more of the graph
> carries `import` provenance instead of last-resort name matching. Deterministic, no LLM, no new
> dependency. Grounded in the north star (`overview/spec.md`, `c6d1ad07`).

## The gap (a precision ceiling, not a bug)

- `IMPORT_RESOLUTION_LANGUAGES` is exactly TS/JS/Python (`import-resolver-bridge.ts:48`), and
  `buildBaseImportMap` (`:52`) dispatches only `parseJSImports`/`parsePythonImports` (`:58-63`).
  Every other callGraph language resolves cross-file calls by bare name — the ladder's last resort,
  "pick first candidate by name" (`call-graph-types.ts:22`), at the highest distance cost
  (`name_only: 3`, `call-graph-types.ts:145`).
- The conformance suite asserts this precision difference explicitly rather than hiding it
  (`language-capability-conformance.test.ts:122-138`: TS cross-file is `import`; Python/Go are
  `name_only`) — see `add-language-capability-conformance`. That scenario is the bar this change
  raises, language by language.
- Dormant groundwork already exists: `parseGoImports` (`import-resolver-bridge.ts:352`),
  `parseRustImports` (`:382`), `parseRubyImports` (`:403`), `parseJavaImports` (`:420`) are written
  but deliberately not wired into the live path (`:44` — "parsers exist elsewhere but are not wired
  … honesty over latent capability").

Cost of the ceiling: on a common name (`parse`, `run`, `build`, `New`) a name-only edge can land on
the wrong same-named definition, and everything downstream (`find_path`, `select_tests`,
`find_dead_code`, blast radius) inherits it. Go is where this bites hardest — flat package-level
function naming makes cross-package name collisions routine.

## What changes — staged, highest value first

| Stage | Languages | Mechanism (per-file facts → resolution) |
|---|---|---|
| 1 | Go | Capture the `package` clause per file (not extracted today) + import aliases (`parseGoImports` exists). Resolve `pkg.Func` via the import path → package → file set, and bare same-package calls via package-sibling files. Near-mechanical; highest collision pressure. |
| 2 | Java, Kotlin, C# | `import` / `using` + `package` / `namespace` declarations → a per-file FQN→file map; qualified and imported-name calls move from `name_only` to `import` confidence (`parseJavaImports` is the seed). |
| 3 | PHP | `use` statements + `namespace` declarations, same FQN→file shape as stage 2. |
| deferred | Ruby | Ranked LAST and explicitly deferred: Ruby has no static import of *names* — `require`/`require_relative` load files, autoload and open classes bind at runtime. A static map would be a guess; the honest state is `name_only` plus the ambiguity guard. Disclosed here rather than silently omitted. |

Every stage lands with the same contract:

- Cross-file edges that resolve through the new map carry `import` confidence (existing enum value —
  no new confidence tier, no new tuning constant; the distance cost table already prices `import`).
- A name the map cannot bind falls through to the existing ladder unchanged — resolution never gets
  *worse*, and never guesses on the new path (unique binding or fall-through).
- The conformance suite's cross-file fixture for that language flips its asserted provenance from
  `name_only` to `import` — the precision-difference scenario in
  `add-language-capability-conformance` is updated, keeping the claim continuously verified.
- The `imports` capability column in the language-support registry grows only with the wired stage
  (it derives from `IMPORT_RESOLUTION_LANGUAGES`, so the matrix cannot over-claim).

**Sibling change:** `harden-call-resolution-ambiguity` (PROPOSED, same audit) adds the refuse-to-
guess ambiguity guard on `name_only`. The two compose: that change stops the resolver from guessing
on collisions; this change shrinks the ambiguous set itself by giving more languages a binding
signal. Neither depends on the other to land.

**Inspiration (cited, kept local):** stack-graphs' architecture lesson — per-file name-binding facts
stitched at query time is what keeps resolution incremental, and per-language rule-authoring cost is
the real risk of name-binding work. Hence per-file import/package facts (already OpenLore's shape)
and a staged plan that buys the most precision per rule authored, rather than a big-bang resolver.
No stack-graphs dependency is added.

## Why this is in scope

The north star promises grounded structural answers. `import`-provenance edges are the grounded
tier; `name_only` is the disclosed fallback. Widening the grounded tier for the languages where
collisions are most likely is a direct precision raise on the substrate every conclusion tool
stands on — no new capability surface, no new tool, no LLM.

## Impact

- `src/core/analyzer/import-resolver-bridge.ts` (wire per-language parsers + package/namespace
  facts into `buildBaseImportMap`/`buildResolvedImportMap`), `call-graph.ts` (Go package-clause
  capture), conformance fixtures per stage.
- Specs: `analyzer` — 1 ADDED requirement (ImportPreciseResolutionBeyondTsJsPython).
- Risk: per-stage regression surface is the resolution ladder; each stage must show a before/after
  structural diff (edges moved `name_only`→`import`, none dropped except genuinely-wrong bindings).
  Ruby stays deferred by design — deferral is disclosed, not a TODO.
