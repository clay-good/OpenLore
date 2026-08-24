# Widen the per-language overlay matrix: Go error flow, Kotlin/Dart types, four CFG languages, Python/Go HTTP clients

> Status: IMPLEMENTED (2026-08-23). Raises an existing, honestly-scoped claim surface: the
> per-capability `*_LANGUAGES` registries are conformance-verified and never over-claim — this
> change grows four of them where the value-per-language is highest, under the same
> constants-grow-only-with-fixtures discipline. Deterministic, no LLM, no new dependency.
> Grounded in the north star (`overview/spec.md`, `c6d1ad07`) and
> `add-language-capability-conformance`'s coverage-guard pattern.

## The gap (four honest `·` cells worth turning into `✓`)

Priority order, highest value first:

1. **errorPropagation for Go.** `ERROR_PROPAGATION_LANGUAGES` is TS/JS/Python only
   (`exception-flow.ts:33`), and the conformance suite asserts Go honestly unsupported
   (`language-capability-conformance.test.ts:160-164`). Go is the famously error-value-centric
   language — `if err != nil` is the idiom — and it is exactly where "what escapes this function?"
   goes unanswered today. **Go's model is different, and the spec says so:** errors are returned
   values, not thrown exceptions. The Go-shaped conclusion is defined honestly — `escapes` =
   returned error values and `panic` sites (with `recover` shielding), `handledInternally` = an
   `err` checked and not returned — never a pretend-exception framing. Java/C# `throws`-clause +
   `throw` analysis is the follow-on stage (their model IS exceptions; the existing shape fits).
2. **typeInference for Kotlin and Dart.** `TYPE_INFERENCE_LANGUAGES` has 9 members
   (`type-inference-engine.ts:27`) — Kotlin and Dart are absent, yet their signal is
   shape-identical to the existing Java/C# inference (explicit local type annotations +
   `Foo()` constructor assignment). Wiring them improves method-dispatch recall through the
   existing receiver-type strategy, with no new inference machinery.
3. **cfgOverlay for Kotlin, Swift, Dart, Scala.** `SPEC_BY_LANGUAGE` (`cfg.ts:481`) is a
   data-driven per-language node-type table (`CfgLangSpec`, `cfg.ts:114`). These grammars expose
   some control-flow children positionally, and Dart exposes its function body as a sibling, so
   the table also supplies narrow shared grammar-shape adapters. The CFG semantics remain common;
   only AST normalization varies by language. These four are callGraph-backed today but CFG-absent.
4. **crossServiceHttp CLIENT side for Python (`requests`/`httpx`) and Go (`net/http`).**
   `HTTP_CLIENT_LANGUAGES` is TS/JS only (`http-capability.ts:14`) while Python ROUTES are already
   extracted (`HTTP_ROUTE_LANGUAGES`, `http-capability.ts:17-19`) — an asymmetry worth naming: a
   Python service's inbound edges exist but its outbound calls are invisible, so a
   Python→anything cross-service edge can never form. Go gets the client half alongside.

## What changes

Each addition follows the established widening contract — no exceptions:

- The registry constant grows **only together with** its conformance fixture(s); the existing
  coverage guards (`add-language-capability-conformance`) fail if a set grows fixture-less.
- The capability matrix stays derived-from-extractors (`language-support.ts`) — the `✓` appears
  because the constant grew, never by hand-editing a table.
- Non-claimed languages keep degrading honestly (explicit `supported: false` / empty result),
  and each capability's known analysis limits are disclosed per language (e.g. Go: an error
  swallowed via `_ =` assignment is disclosed as a boundary, not guessed at).

## Why this is in scope

Every cell here deepens an existing conclusion tool on code agents already navigate —
`analyze_error_propagation`, method-dispatch resolution, CFG-backed complexity, and
`http_endpoint` blast radius — with zero new tool surface, zero LLM, zero dependency. It is the
capability matrix doing what it was built for: making widening safe because over-claiming is
structurally prevented.

## Impact

- `src/core/analyzer/exception-flow.ts` (Go value-flow extraction + the Go-shaped result fields;
  then Java/C#), `type-inference-engine.ts` (Kotlin/Dart cases + set), `cfg.ts` (four
  `CfgLangSpec` entries), `http-capability.ts` + the client-call extractor (Python/Go client
  patterns), conformance fixtures for every grown set.
- Specs: `analyzer` — 4 ADDED requirements (GoErrorPropagationIsValueShaped,
  TypeInferenceCoversKotlinAndDart, CfgOverlayCoversKotlinSwiftDartScala,
  HttpClientExtractionCoversPythonAndGo).
- Risk: Go error-flow is the only genuinely new conclusion shape (value tracking, not throw/catch
  containment) — it lands as a sound lower bound with disclosed boundaries, per the honesty
  contract. CFG widening adds only the positional/sibling-body adapter hooks recorded in decision
  `ab31d966`; the control-flow engine remains shared. The remaining changes are table/pattern
  extensions of proven engines. No MCP tool count change, so no payload-budget movement.
