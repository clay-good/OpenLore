# Add deprecation propagation: extract the deprecated bit in the existing walk, surface it as a finding

> Status: SHIPPED, narrowed (2026-10-18). Proposed 2026-07-08 (e2e audit fifth pass — fifth research sweep). Prior art:
> staticcheck's SA1019 (https://staticcheck.dev/changes/2017.2,
> https://github.com/dominikh/go-tools/issues/317) — an entire, widely-trusted check built on
> nothing but Go's `// Deprecated:` doc-comment convention; eslint-plugin-deprecation — the same
> check for TS, but requiring the type checker (OpenLore's resolution ladder with disclosed
> confidence is the honest lighter-weight analog); PEP 702 / `warnings.deprecated`
> (https://peps.python.org/pep-0702/) — Python standardizing the marker as a decorator.

## The gap

Deprecation markers are structured, language-standard, and sitting in text OpenLore **already
reads**: `extractDocstringBefore` (`src/core/analyzer/call-graph-extract.ts:14-20`) scans the doc
comment block above every function during the main walk — JSDoc, Go `//` lines, Rust/Swift `///`,
Ruby `#`, and Python's in-body docstring — and stores its first meaningful line as
`FunctionNode.docstring` (`src/core/analyzer/call-graph-types.ts:69-70`). Yet the substrate cannot
answer "does my diff add calls into deprecated code?", the question staticcheck answers for Go and
the type checker answers for TS. Every ingredient exists: the comment scan, the call graph for the
"who calls it" join, `FINDING_CODE_REGISTRY` for advisory surfacing
(`src/core/services/mcp-handlers/enforcement-policy.ts:81`), and the derived capability registry
for language honesty. This is the cheapest borrow of the sweep: one bit plus one string per symbol,
extracted where the cursor already is (the style-fingerprint precedent — measured during the
existing walk, no second parse: `src/core/analyzer/style-fingerprint.ts`).

## What changes

**Extraction (analyzer).** During the existing doc-comment scan, detect the language's standard
deprecation marker and record `deprecated: true` plus the marker's free-text remainder (the
replacement hint) on the node:

| Language | Marker (all pre-existing conventions, no invented syntax) |
|---|---|
| TS/JS | JSDoc `@deprecated` in the leading doc comment |
| Go | a `// Deprecated:` paragraph — SA1019's exact convention |
| Python | PEP 702 `@warnings.deprecated(...)` / `@typing_extensions.deprecated(...)` decorator, and a `.. deprecated::` docstring directive |
| Kotlin/Java | `@Deprecated` annotation |

Language honesty: exactly the conventions implemented, published as a derived `deprecationMarkers`
capability in the registry (`get_language_support` — derived from the live extractor, so it cannot
over-claim; the `errorPropagation`/`styleFingerprint` column precedent). Every other language: null
signal, never a guess.

**Surfacing (mcp-handlers) — three ways, NO new tool:**

1. A governance finding code **`deprecated-symbol-use`** registered in `FINDING_CODE_REGISTRY`,
   advisory by default per the shipped enforcement-policy pattern — emitted when a diff adds a new
   call edge whose target is deprecated. Blocking stays opt-in via `enforcement.policy`.
2. A field in `blast_radius` (`src/core/services/mcp-handlers/blast-radius.ts`) and
   `structural_diff` (`structural-diff.ts`): "this diff adds N new calls into deprecated symbols",
   each with caller, target, file:line, and the target's replacement hint. Pre-existing calls into
   deprecated code are visible but distinguished from newly-added ones — the finding fires only on
   the new edges.
3. **Migration targets resolved deterministically ONLY when the hint text names a symbol that
   resolves in the index** (e.g. "Deprecated: use NewClient instead" where `NewClient` is an
   indexed symbol → the resolved node is attached). Otherwise the raw hint text is passed through
   labeled `unresolved` — no fuzzy matching, no guessing.

Sibling coordination (cross-reference, do not modify): `refine-public-surface-certification`
(pass 3) should treat "newly deprecated export" as a **non-breaking** rule code when its rule-code
vocabulary lands — deprecation is the contract's warning channel, not a break; this change only
supplies the bit that rule needs. `find_dead_code` is the adjacent conclusion for the *next* step
(a deprecated symbol with zero callers is removal-ready) — cross-referenced, not merged, since each
returns a distinct conclusion (NoRedundantConclusions).

No dependency-decision table: there is no real dependency choice here — the markers are read from
source in the existing walk, and the only alternative (a type-checker-backed check, the
eslint-plugin-deprecation route) is rejected in the prior-art line for requiring a compiler the
substrate deliberately does not have.

## Why this is in scope

Deterministic, local, no LLM, no threshold — a bit read from language-standard text plus a pure
graph join (decision `c6d1ad07`). It upgrades three existing conclusions (`blast_radius`,
`structural_diff`, the enforcement gate) with information the walk already passes over, at near-zero
marginal cost and zero new tool surface.

## Impact

- Analyzer: extend the doc-comment scan in `src/core/analyzer/call-graph-extract.ts` (+ the
  Python decorator check in the extractor path) to set `deprecated` + `deprecationHint` on
  `FunctionNode` (`call-graph-types.ts`); persisted with the graph artifact; `deprecationMarkers`
  capability derived into the language-support registry.
- mcp-handlers: `deprecated-symbol-use` in `FINDING_CODE_REGISTRY`
  (`enforcement-policy.ts:81`), new-calls-into-deprecated field in `blast_radius` and
  `structural_diff`, index-resolved-or-unresolved migration hint.
- Tool count unchanged (72 — no new tool); tools/list payload budget in
  `src/cli/commands/mcp-presets.test.ts` (full < 88k, ~line 582) re-asserted (description text for
  the two extended tools grows slightly).
- Specs: `analyzer` — 1 ADDED (DeprecationMarkersAreExtractedInTheExistingWalk); `mcp-handlers` —
  1 ADDED (DeprecatedSymbolUseIsAnAdvisoryFindingWithHonestHints).
- Honesty boundaries: marker detection is per-implemented-convention only (registry-derived, others
  null); a hint that does not resolve stays raw text labeled `unresolved`; a deprecated marker on a
  symbol the graph could not index (unsupported language, unparsed file) is out of scope and NOT
  reported absent — the capability registry says "unsupported here".
- Risk: false positives from the word "deprecated" in ordinary prose (mitigated: match the
  structural conventions exactly — JSDoc tag, Go paragraph prefix, decorator, annotation — never a
  substring of free text); hint resolution ambiguity (mitigated: resolve only an unambiguous index
  match; ambiguity → `unresolved` with candidates, the `find_clones` not-found discipline).
