# Tasks — Cross-service API topology

> Status: IMPLEMENTED (2026-06-26). Key finding during implementation: the single-repo
> client→handler projection **already existed** (call-graph Pass 2b, `http_endpoint`
> edges) but was untested at the call-graph layer and silently broken for the most common
> Node idiom (top-level Express route registration). The proposal's "for free under
> federation" assumption was **wrong** — federation matches by symbol name, cross-service
> by route key — so the cross-repo bridge was genuinely net-new. Work below reflects that.

## 1. Client call-site extraction (the missing half)
- [x] Framework-aware static scanner for outbound HTTP call sites (`fetch`, axios/ky/got).
      ALREADY PRESENT: `extractHttpCalls` (`http-route-parser.ts`) recovers method + path +
      enclosing function (via the call line). Reuses the existing extractor; not rewritten.
- [x] Gate per framework/language through the language-support registry (coverage observable).
      ADDED: `crossServiceHttp` capability column, derived from `CROSS_SERVICE_HTTP_LANGUAGES`
      (leaf module `http-capability.ts`), behaviorally cross-checked in `language-support.test.ts`.

## 2. Matcher
- [x] Normalized route key + path-parameter normalization (`:id`/`{id}`/concrete reconcile).
      ALREADY PRESENT: `normalizeUrl` + `candidatePaths` + `buildHttpEdges` (exact/path/fuzzy).
- [x] Exact structural match; ambiguous/dynamic → no edge. ALREADY PRESENT; now proven by tests.

## 3. Projection (no schema/tool change)
- [x] Project matched pairs as `http_endpoint` function→function edges. ALREADY PRESENT
      (call-graph Pass 2b). FIXED two defects that dropped the edge for Express / same-language
      full-stack: (a) Express route line off-by-one mis-resolved the handler name; (b)
      `extractAllHttpEdges` never extracted TS/JS routes, only Python/Java.
- [x] Confirm `analyze_impact` / `find_path` / `blast_radius` pick up the edges with no tool
      change. CONFIRMED: `reachability.ts` already treats `http_endpoint` callees as liveness
      roots / impact consumers. Proven end-to-end (`cross-service-topology.test.ts`).

## 4. Federation
- [x] Cross-repo client→handler link. NET-NEW: `findCrossRepoClientCallers` (federation
      resolver) matches a federated repo's client calls against a home handler's route key via
      the same `buildHttpEdges`; surfaced as `crossServiceConsumers` in `analyze_impact`'s
      federation block. Single-repo links need no federation (unchanged).

## 5. Honesty / determinism
- [x] Dynamic/unresolved targets emit nothing. Proven (single-repo + cross-repo tests).
- [~] Known-unknowable confidence-boundary note for dynamic targets. DEFERRED — the spec wording
      is "eligible for / MAY". The no-edge contract is met and proven; emitting the disclosure
      needs a new dynamic-call-detection pass (today only static calls are surfaced) + boundary
      wiring, which is speculative for marginal value. Tracked as a follow-up.
- [x] Deterministic, byte-identical re-analysis. Proven (determinism tests, both layers).

## 6. Tests & fixtures
- [x] Single-repo full-stack fixture: client `fetch` → handler; impact surfaces the client caller
      (`cross-service-topology.test.ts`, 6 cases).
- [x] Path-parameter normalization (`${id}` ↔ `:id`/`{id}`).
- [x] Dynamic target → no edge; unmatched route → no edge.
- [x] Cross-repo federation: client in one indexed repo → handler in another
      (`cross-service-resolver.test.ts` + e2e `cross-service-impact.test.ts`).
- [x] Determinism (both layers).

## 7. Verify & dogfood
- [x] `npm run lint`, `tsc --noEmit`, `npm run test:run` (5279 passed; 2 pre-existing load-flakes
      pass in isolation), `npm run build` — all green.
- [x] Dogfood: real `openlore analyze` on a TS+Express full-stack repo emits `loadUser→getUser`
      and `createUser→addUser` as `http_endpoint` edges; coverage matrix shows `crossServiceHttp`.

## 8. Docs
- [x] `docs/language-support.md`: `crossServiceHttp` capability row + add-a-language checklist step.
- [x] `docs/cross-service-topology.md`: static HTTP-only v1, matching/normalization, the
      no-edge-on-dynamic contract, federation behavior, and deferred transports (gRPC, queues,
      GraphQL, tRPC) + optional OpenAPI strengthening.
