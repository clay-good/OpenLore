# Tasks — Multi-repo federation

> Phase-2; build after the five memory + dispatch changes. Likely splits into sub-PRs (registry →
> resolution → query → memory). Call `record_decision` before the registry schema (data structure)
> and the cross-repo resolution contract (API contract), per `CLAUDE.md`.
>
> STATUS (2026-06-19): groups 1–3 + 5 IMPLEMENTED on `feat/multi-repo-federation`; group 4 DEFERRED
> (needs bitemporal memory, PR #163, not yet in main). Decisions `bf5aff2d`, `67ca60fe`.

## 1. Federation registry (foundation)
- [x] Define a registry manifest: per-repo `{ path|remote, fingerprint, schemaVersion, lastBuilt }`.
      → `src/core/federation/types.ts` (`FederationRepoEntry`), project-local `.openlore/federation.json`.
- [x] `openlore federation add|remove|list` (or equivalent) edits the registry; each repo builds its
      own local index independently. No global build. → `src/cli/commands/federation.ts`, `registry.ts`.
- [x] Test: adding/removing a repo updates only the registry + that repo's index.
      → `src/core/federation/registry.test.ts` (add/remove/dedupe/name-clash/home-repo-reject).

## 2. Cross-repo symbol resolution (reuse stable IDs)
- [x] Resolve a published symbol's consumers across indexed repos via content-addressed stable IDs /
      SCIP monikers. Exact-match only; no guessing. → `resolver.ts` `findCrossRepoConsumers(Batch)`,
      `EdgeStore.getExternalConsumers`. Match is on the stable-ID *name descriptor* against consumer
      external call targets (call sites carry no signature) — disclosed in `caveats`.
- [x] Report unindexed/stale repos explicitly (hand off to `add-confidence-boundary-disclosure`).
      → `repoStatus` / `evaluateRepoState`; every conclusion carries `reposConsulted` / `reposSkipped`.
- [x] Test: a symbol exported by repo A resolves to its callers in indexed repo B and reports repo C
      (unindexed) as not-consulted. → `resolver.test.ts` (consumer resolution + stale-skip).

## 3. Federation-scoped queries (lazy + budgeted)
- [x] Add an optional federation scope to `analyze_impact`, `find_path`, `find_dead_code`,
      `select_tests`; load per-repo indexes on demand; respect a token budget; name repos consulted.
      → `graph.ts`, `pathfind.ts`, `reachability.ts`, `test-impact.ts`; lazy `readCachedContext`;
      `DEFAULT_MAX_CONSUMERS` cap; coverage named in every response.
- [x] Test: cross-repo dead-code on a shared export is correct and bounded; result lists repos seen.
      → `resolver.test.ts` + e2e dogfood (`DOGFOOD-federation.md`): `find_dead_code` keeps a producer
      symbol alive via a consumer; `analyze_impact` names the consumer; `select_tests` selects the
      consumer's test; `find_path` locates the producer + bridge.

## 4. Fleet-level memory and decisions  — DONE (PR #168, ADR-0019); needed bitemporal memory (PR #163, now in main)
- [x] A memory anchored to a published interface surfaces in consumer repos. `recall` gains opt-in
      `federation`/`federationRepos`; `src/core/federation/fleet-memory.ts` (`findFleetMemory`) resolves
      the home repo's external references to producer repos, selects producer memories anchored to those
      interfaces, and computes freshness against the PRODUCER's graph (orphaned/retired withheld).
      `edge-store.getExternalReferenceNames()` provides the home's consumed interfaces. Matched by symbol
      name (arity unconfirmed at an external call site — the standard federation caveat).
- [x] Test: `fleet-memory.test.ts` (fresh surfaces, orphaned withheld, retired excluded, not-consumed
      excluded, cap/truncation) + real-two-repo e2e dogfood (fresh surfaces with verdict; stale producer
      skipped with reason; orphaned producer anchor withheld while consulted).
- [x] Decision side (PR #168 follow-up): `findFleetMemory` also surfaces active producer **decisions**
  anchored to a consumed interface, in a `decisions` array, with producer-side freshness (orphaned
  withheld, inactive excluded). `record_decision` auto-anchors to the symbol, so a producer decision
  surfaces in the consumer's `recall.fleetMemory.decisions` (verified by `fleet-memory.test.ts` + e2e).

> **RE-HOMED (PR #168).** The `FleetLevelAnchoredMemory` requirement is now promoted into the live
> `openspec/specs/mcp-handlers/spec.md` (memory path), since PR #163 (bitemporal typed memory) is in
> `main`. The DEFERRED copy below in this change's `specs/mcp-handlers/spec.md` is left as the historical
> proposal record and MUST still NOT be re-merged at archive time (it would duplicate the live one).

## 5. Surface + docs
- [x] Register federation capability behind an opt-in `federation` preset; nothing in the default.
      → `TOOL_PRESETS.federation` + `federation_status` (preset-only); `mcp-presets.test.ts` guards it.
- [x] Document the index-of-indexes model and local-first posture in `architecture` + `CODEBASE.md`.
      → this proposal + `DOGFOOD-federation.md`; spec deltas in `specs/`.
