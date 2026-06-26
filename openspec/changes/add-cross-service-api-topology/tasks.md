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
- [x] METHOD PRECISION (found in review): `buildHttpEdges` previously created a low-confidence
      edge on a method MISMATCH (a `POST` client linking to a `GET` handler on the same path) AND
      its dedup key omitted the handler, so two handlers for one path collapsed — dropping the
      correct edge. Now: both methods known and different → no edge (a match needs method
      compatibility, equal or one UNKNOWN). A `GET` client → its `GET` handler, `POST` → `POST`.

## 3. Projection (no schema/tool change)
- [x] Project matched pairs as `http_endpoint` function→function edges. ALREADY PRESENT
      (call-graph Pass 2b). FIXED FOUR defects (all found by adversarial dogfooding on real
      `openlore analyze`, each silently dropped the edge):
      (a) Express route line off-by-one mis-resolved the handler name;
      (b) `extractAllHttpEdges` never extracted TS/JS routes, only Python/Java (same-language);
      (c) Pass 2b required the handler node in the SAME file as the route, so any framework with
          a routing table separate from handler defs (Django `urls.py`→`views.py`, separate Express
          routes files) never resolved — now falls back to a UNIQUE cross-file name match;
      (d) Next.js App Router route-path derivation used `lastIndexOf('/app/')`, which missed a
          leading `app/` segment in the REPO-RELATIVE paths the analyze pipeline passes — collapsing
          the route to `/` (also broke the route inventory). Now forces a leading slash first.
- [x] Confirm `analyze_impact` / `find_path` / `blast_radius` pick up the edges with no tool
      change. CONFIRMED: `reachability.ts` already treats `http_endpoint` callees as liveness
      roots / impact consumers. Proven end-to-end (`cross-service-topology.test.ts`).

## 4. Federation
- [x] Cross-repo client→handler link. NET-NEW: `findCrossRepoClientCallers` (federation
      resolver) matches a federated repo's client calls against a home handler's route key via
      the same `buildHttpEdges`; surfaced as `crossServiceConsumers` in `analyze_impact`'s
      federation block. Single-repo links need no federation (unchanged).
- [x] SEPARATE-FILE handlers cross-repo (found in review): `deriveSeedRoutes` now reads the home
      repo's persisted `route-inventory.json` (every route, by handler name) instead of parsing
      only the seed's own file — so a Django (`urls.py`→`views.py`) or separate-Express-routes
      handler resolves its route key cross-repo too, matching the single-repo projection. Falls
      back to per-seed-file parsing when no inventory artifact exists. Stale scoped repos are
      skipped by fingerprint (verified by dogfood), never queried out of date.

## 5. Honesty / determinism
- [x] Dynamic/unresolved targets emit nothing. Proven (single-repo + cross-repo tests).
- [~] Known-unknowable confidence-boundary note for dynamic targets. DEFERRED — the spec wording
      is "eligible for / MAY". The no-edge contract is met and proven; emitting the disclosure
      needs a new dynamic-call-detection pass (today only static calls are surfaced) + boundary
      wiring, which is speculative for marginal value. Tracked as a follow-up.
- [x] Deterministic, byte-identical re-analysis. Proven (determinism tests, both layers).

## 6. Tests & fixtures
- [x] Single-repo full-stack fixture: client `fetch` → handler; impact surfaces the client caller
      (`cross-service-topology.test.ts`).
- [x] Path-parameter normalization (`${id}` ↔ `:id`/`{id}`).
- [x] Dynamic target → no edge; unmatched route → no edge.
- [x] Separate-file handler resolution (Django `urls.py`→`views.py`, separate Express routes file)
      + the ambiguous-name negative (a name colliding across files stays unresolved, no guessed edge).
- [x] Next.js App Router route-path from a repo-relative `app/...` path (`ts-route-extractor.test.ts`).
- [x] Cross-repo federation: client in one indexed repo → handler in another, incl. a
      SEPARATE-FILE (Django via route inventory) case and a negative
      (`cross-service-resolver.test.ts` + e2e `cross-service-impact.test.ts`).
- [x] Method precision: a GET client and a POST client on one path link to their OWN handlers,
      never cross-linked; UNKNOWN-method side still links (`http-route-parser.test.ts`).
- [x] Determinism (both layers).

## 7. Verify & dogfood
- [x] `npm run lint`, `tsc --noEmit`, `npm run test:run` (5279 passed; 2 pre-existing load-flakes
      pass in isolation), `npm run build` — all green.
- [x] Dogfood: real `openlore analyze` across FastAPI/Flask/Django/Spring/NestJS/Next.js/Express with
      fetch/axios/ky/got clients — every framework links, dynamic + orphan targets emit no edge;
      coverage matrix shows `crossServiceHttp`. Real cross-repo federation: `analyze_impact` on a
      FastAPI handler surfaces a `fetch` consumer in a separate web repo.

## 8. Docs
- [x] `docs/language-support.md`: `crossServiceHttp` capability row + add-a-language checklist step.
- [x] `docs/cross-service-topology.md`: static HTTP-only v1, matching/normalization, the
      no-edge-on-dynamic contract, federation behavior, and deferred transports (gRPC, queues,
      GraphQL, tRPC) + optional OpenAPI strengthening.
