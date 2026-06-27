# Per-language capability conformance: verify the claimed matrix against real extraction

> Status: IMPLEMENTED (2026-06-26, on PR #216). Adds a committed conformance sweep that drives the
> real extractors against a minimal realistic fixture for every language the registry CLAIMS supports
> a capability, so the `get_language_support` matrix is *verified*, not merely *asserted*. Deterministic,
> no LLM. Grounded in the north star (`overview/spec.md`, `c6d1ad07`) and the `mcp-quality`
> NoFalseCompleteness discipline.

## The gap

The capability matrix surfaced by `get_language_support` is derived from per-capability `*_LANGUAGES`
constants (`CALLGRAPH_LANGUAGES`, `SIGNATURE_LANGUAGES`, `ERROR_PROPAGATION_LANGUAGES`, …). That makes
the matrix *honest about what it claims* — but a constant listing a language as callGraph-supported
does not, by itself, prove the extractor produces a real edge on real code for that language. A
regression that silently broke one language's call-graph extraction would leave the matrix
**over-claiming** with nothing to catch it.

## What changed

A new committed test — `src/core/analyzer/language-capability-conformance.test.ts` — performs a
systematic per-language sweep that drives the actual extraction engine behind the core navigation
tools (the call graph underpins `orient`, `analyze_impact`, `find_path`, `get_subgraph`,
`select_tests`, `find_dead_code`, `trace_execution_path`) plus the error-propagation overlay:

1. **Basic call graph** — for every one of the **18 languages** the registry claims supports
   `callGraph`, a `caller→callee` fixture must yield both functions and the resolved edge. A guard
   test fails if the registry adds a callGraph language with no conformance fixture.
2. **Intra-class method dispatch** — `this.`/`self.`/implicit-receiver → sibling method resolves for
   every class-bearing language (TS, JS, Python, Go, Ruby, Java, Kotlin, PHP, C#, Scala, Swift, Dart).
3. **Cross-file resolution** — a call whose callee lives in another file resolves, with the precision
   difference asserted explicitly (see below).
4. **Error-propagation overlay** — TS/JS/Python extract the thrown/raised type; a non-claimed language
   is honestly reported `supported: false`, never silently empty.

The sweep then drives the four **richer per-capability overlays** against their narrower claimed
language sets, each with a coverage guard that fails if the registry adds a language without a fixture:

5. **CFG overlay** (11 languages) — a branchy function yields a structurally-valid CFG (`isStructurallyValid`).
6. **Type inference** (9 languages) — a local variable resolves to its class type; a non-claimed language returns an empty inference.
7. **Style fingerprint** (4 languages) — a file above the evidence floor tallies idioms; a non-claimed language tallies nothing.
8. **Cross-service HTTP** (4 languages) — a server route definition is extracted (Express/Flask/Spring); outbound client calls are extracted for the 2 client languages.
9. **IaC projection** (12 ecosystems) — for every ecosystem in `IAC_LANGUAGES`, the real projector
   (`buildProjectedIac`) turns a minimal realistic fixture's resources/jobs/tasks into graph nodes,
   and where the ecosystem models a cross-reference produces a `references`/`depends_on` edge. A
   coverage guard fails if `IAC_LANGUAGES` grows without a fixture.

## Findings from the sweep (2026-06-26)

The engine is **sound across all 18 call-graph languages, every richer overlay's claimed language
set, and all 12 IaC ecosystems** — basic calls, intra-class method dispatch, cross-file resolution,
CFG, type inference, style, cross-service HTTP, and IaC projection all fire; no correctness gaps were
found, the claimed matrix does not over-claim, and non-claimed languages degrade honestly
(empty/absent, never a guess). All 12 IaC ecosystems project nodes; 8 produce reference/dependency
edges from a simple two-resource fixture (Terraform, Kubernetes, CloudFormation, Ansible, Dockerfile,
Docker Compose, GitHub Actions, Bicep). One **precision** difference was surfaced and is now asserted
rather than hidden:

- **Cross-file call provenance varies by language.** TypeScript resolves a cross-file call via precise
  **`import`** resolution; Python and Go resolve the same shape via **`name_only`** (name match, no
  import binding). The edge is found in every case (navigation works), but the provenance confidence
  is lower for the name-only languages. This is consistent with which languages have import
  resolution and is documented, not a defect.

This is a baseline: the test is the place future language work raises the bar (e.g. promoting a
language from `name_only` to import-precise cross-file resolution).

## Why this is in scope

Pure verification of an existing claim surface — no new capability, dependency, or LLM. It converts
the language matrix from a derived assertion into a continuously-verified guarantee, directly serving
the `mcp-quality` NoFalseCompleteness requirement and the substrate's honesty contract.

## Impact

- New: `src/core/analyzer/language-capability-conformance.test.ts` (73 cases — call graph, method
  dispatch, cross-file, error-propagation, CFG, type inference, style, cross-service HTTP) and
  `src/core/analyzer/iac/iac-projection-conformance.test.ts` (21 cases — all 12 IaC ecosystems).
- Specs: `analyzer` — 1 ADDED requirement (CapabilityMatrixIsConformanceVerified).
- Risk: none (test-only).
