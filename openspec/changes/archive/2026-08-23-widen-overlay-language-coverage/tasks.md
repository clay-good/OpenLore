# Tasks — widen overlay language coverage

## Implementation
- [x] Go errorPropagation: extract returned-error / `panic` escape sites and
      `err`-checked-not-returned / `recover` internal handling; Go-shaped result fields (values,
      not exceptions); disclose swallowed-error (`_ =`) and unanalyzable-callee boundaries
- [x] Java/C# errorPropagation follow-on: `throw` sites + `throws` clauses + `catch` containment
      on the existing exception-shaped result
- [x] Kotlin + Dart typeInference: explicit local annotations + `Foo()` constructor assignment
      (mirror the Java/C# extractors); add to `TYPE_INFERENCE_LANGUAGES`
- [x] CFG overlay: `CfgLangSpec` table entries for Kotlin, Swift, Dart, Scala in
      `SPEC_BY_LANGUAGE` (`cfg.ts`)
- [x] Python (`requests`/`httpx`) + Go (`net/http`) HTTP client call-site extraction; add to
      `HTTP_CLIENT_LANGUAGES` (`http-capability.ts`) so Python/Go outbound edges can match
      existing routes

## Conformance
- [x] Go error-flow fixtures: returned error escapes; checked-and-not-returned is
      handledInternally; `panic` escapes unless recovered; `_ =` swallow is a disclosed boundary
- [x] Kotlin/Dart type-inference fixtures: local `val x: Foo` / `final Foo x = Foo()` resolves a
      method call to the class; non-member languages still return empty
- [x] CFG fixtures: branchy Kotlin/Swift/Dart/Scala functions yield structurally-valid CFGs
- [x] HTTP client fixtures: a Python `requests.get` / Go `http.Get` call site matches an extracted
      route into an `http_endpoint` edge
- [x] All existing coverage guards stay green — every grown `*_LANGUAGES` set has its fixture, and
      the derived matrix flips cells without hand edits

## Verification
- [x] `get_language_support` matrix shows the new `✓` cells purely via registry derivation
- [x] Full suite green

## Spec
- [x] `analyzer` delta: ADD GoErrorPropagationIsValueShaped, TypeInferenceCoversKotlinAndDart,
      CfgOverlayCoversKotlinSwiftDartScala, HttpClientExtractionCoversPythonAndGo
