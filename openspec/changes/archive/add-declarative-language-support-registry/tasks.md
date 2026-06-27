# Tasks — Declarative language-support registry

> Status: IMPLEMENTED (2026-06-25, PR #203). Core: `src/core/analyzer/language-support.ts`
> (registry + coverage matrix, DERIVED from the live extractor structures). Tool:
> `src/core/services/mcp-handlers/language-support.ts` (`get_language_support`, conclusion,
> full-surface/opt-in). Coverage matrix emitted into `CODEBASE.md` via `codebase-digest.ts`.
> Tests: `analyzer/language-support.test.ts` + `mcp-handlers/language-support.test.ts`.
> Docs: `docs/language-support.md`. Dogfooded on this repo (25 languages; caught + fixed a
> CDK/CDKTF/Pulumi under-claim).
>
> **Round-2 adversarial hardening (PR #203):** an e2e harness + adversarial review found and fixed —
> (1) a docs-only/zero-detected repo returned ALL languages falsely marked `detectedInRepo:true`
> (`languageCoverageMatrix([])` now yields NO rows, distinct from `undefined`→all); (2) the
> faithfulness guard was only exact for cfgOverlay/iacProjection — now EVERY member of every
> capability set (callGraph 18, signatures 20, typeInference 9, imports 3) is behaviorally
> cross-checked against the real extractor on a fixture, so the sets can't silently over-claim;
> (3) named lookup is now case-insensitive + trimmed (`resolveLanguageName`); (4) completeness guard
> now includes `CFG_LANGUAGES` (exported from cfg.ts); (5) explicit negative-preset assertion added.
>
> **Round-3 verification (PR #203):** traced the cfg/iac predicates to source — both are sound by
> construction (the pipeline invokes `buildCfgFor` per CFG language using the same `SPEC_BY_LANGUAGE`
> `cfgSupportsLanguage` checks; every `IAC_LANGUAGES` tag is a real `language:` string an IaC extractor
> assigns to nodes, incl. `cdk.ts` `language: c.flavor` for CDK/CDKTF and `pulumi.ts` for Pulumi). Added
> the one remaining behavioral cross-check — `cfgOverlay` is now verified for every `CFG_LANGUAGES`
> member via `CallGraphBuilder.build().cfgs` (6 of 7 capabilities behaviorally tested; iacProjection
> anchored by `iac/*.test.ts` + e2e). Real-pipeline e2e (analyze a polyglot+IaC repo): `detectedLanguages`
> EXACTLY equals the index's distinct node languages, no 0-capability detected language, dispatch==handler,
> JSON round-trips losslessly, and the CODEBASE.md coverage section matches the tool output.

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
