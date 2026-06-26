# Tasks — Public API surface contract  (SHIPPED 2026-06-25)

## 1. Public surface extraction
- [x] Discover public entry points (language visibility via `parseJSExports`/Python convention;
      manifest `exports`/`main` informs the surface listing); fail-soft where unsupported (TS/JS/Python
      classified, other languages contribute surface membership only). `export async function` recovered
      locally (the shared `parseJSExports` misses it).
- [x] Build the public-surface set: each exported symbol with its normalized signature; functions carry
      source spans (for continuity) and node ids (for consumers). Deterministic.

## 2. Breaking-change classification
- [x] Classify each surface symbol's change `breaking | non-breaking | potentially-breaking` per the
      closed rule set (`src/core/analyzer/public-surface.ts`); `potentially-breaking` whenever
      compatibility can't be proven (never silently non-breaking). Union-membership subset test decides
      narrow/widen soundly.
- [x] Use the rename/move continuity map (`computeContinuity`) so a renamed export is a rename, not
      remove+add.
- [x] Resolve breaking consumers: in-repo via the edge store; external/unindexed → known-unknowable
      disclosure (cross-repo federated resolution deferred to a follow-up; disclosed-as-unknowable now).

## 3. MCP + CLI surface
- [x] Opt-in `certify_public_surface` (no base → surface; base ref → breaking verdict + breaking
      consumers + overall summary); input schema; classified `conclusion` in `tool-contract.ts`;
      `full`-preset only (never minimal/navigation); reuses confidence-boundary/staleness disclosure.
- [x] CLI equivalent `openlore certify-public-surface [--base <ref>] [--max <n>] [--json]`.

## 4. Tests & fixtures
- [x] One case per class (`public-surface.test.ts`, both pure + handler): removed export, renamed export
      (via continuity), added-required-param, narrowed return, added-trailing-optional (non-breaking),
      untyped/type-loss (potentially-breaking), new export (non-breaking).
- [x] Consumers named: in-repo callers listed (stub edge store + real e2e dogfood); external →
      known-unknowable. (Federation fixture deferred with the resolver.)
- [x] Determinism: classification byte-identical across runs.

## 5. Verify & dogfood
- [x] `npm run lint`, `npm run typecheck`, `npm run test:run` (5147 passed), `npm run build` green.
- [x] Dogfood: e2e on a throwaway package (analyze base → rename + added-required-param + removed export
      → `certify-public-surface --base HEAD`) — verdict BREAKING, each breaking change named its in-repo
      consumer (rename→billing, param→welcome, removal→billing); also ran against this repo's own diff.

## 6. Docs
- [x] Documented the tool + CLI in `CLAUDE.md` (tool table), the classification rules and conservative
      (potentially-breaking) contract in the module headers, and the distinction from
      `change_impact_certificate`. Updated the MCP tool-count doc guard (66 → 67) and payload budget.
