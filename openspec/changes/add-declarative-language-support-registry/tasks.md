# Tasks — Declarative language-support registry

> Status: IMPLEMENTED (2026-06-25, PR #203). Core: `src/core/analyzer/language-support.ts`
> (registry + coverage matrix, DERIVED from the live extractor structures). Tool:
> `src/core/services/mcp-handlers/language-support.ts` (`get_language_support`, conclusion,
> full-surface/opt-in). Coverage matrix emitted into `CODEBASE.md` via `codebase-digest.ts`.
> Tests: `analyzer/language-support.test.ts` (16, faithfulness/fail-soft/determinism) +
> `mcp-handlers/language-support.test.ts` (7). Docs: `docs/language-support.md`. Dogfooded on this
> repo (25 languages; caught + fixed a CDK/CDKTF/Pulumi under-claim).

## 1. Registry model
- [x] Define the `LanguageSupport` record: capability flags (`signatures`, `callGraph`, `imports`,
      `cfgOverlay`, `typeInference`, `styleFingerprint`, `iacProjection`) + the backing data each
      consumes. Implemented as `Capability` + `LanguageSupportRecord`.
- [x] Stand up one in-tree registry as the single source of truth, keyed by language
      (`LANGUAGE_SUPPORT`). DERIVED from the live sources — not hand-listed — so it cannot drift.

## 2. Represent existing languages faithfully
- [x] A record for every currently-supported language; declared capabilities match actual extractor
      output (the registry is computed from the same structures the extractors consult).
- [x] Reference (not duplicate) the existing per-capability data: `cfgSupportsLanguage` (cfg.ts),
      `isIacLanguage`/`IAC_LANGUAGES` (iac), and authoritative sets newly exported from call-graph,
      signature-extractor, type-inference-engine, import-resolver-bridge.
- [x] Fail-soft is uniform: no record / unbacked capability → nothing produced, no error
      (`languageSupport` returns `{ known:false, capabilities:[] }`).

## 3. Coverage surface
- [x] Deterministic coverage matrix (language × capability), `languageCoverageMatrix()`.
- [x] Emit a **Language coverage** section into `CODEBASE.md` (`codebase-digest.ts`).
- [x] Opt-in `get_language_support` MCP tool (repo-detected languages or a named language) with input +
      structured output schemas; classified `conclusion`; full-surface only (not lean/minimal).

## 4. Tests & fixtures
- [x] Registry-faithfulness: cfgOverlay/iacProjection asserted EXACTLY against their predicates for
      every language; callGraph/signatures/typeInference/imports sets validated against real extractor
      behavior on fixtures (no over-claim).
- [x] Fail-soft: an unknown language yields nothing, no error.
- [x] Coverage-matrix determinism (two derivations byte-identical; sorted regardless of input order).
- [x] No-regression: extraction output is byte-stable (no extractor logic changed — only additive
      exported sets; full suite green: 247 files / 4996 tests).

## 5. Verify & dogfood
- [x] `npm run lint`, `npm run typecheck`, `npm run test:run`, `npm run build` green.
- [x] Dogfood: `get_language_support` on this polyglot repo (25 detected languages); the matrix matched
      reality and SURFACED a real gap (CDK/CDKTF/Pulumi under-claimed `iacProjection`), now fixed +
      guarded by a regression test deriving the IaC tag set from `IAC_LANGUAGES`.

## 6. Docs
- [x] Canonical "add a language" checklist + capability set + fail-soft contract (`docs/language-support.md`).
- [x] `get_language_support` row in `docs/mcp-tools.md`; tool-count guard updated 64→65 across guarded docs.
