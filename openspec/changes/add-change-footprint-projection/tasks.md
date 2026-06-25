# Tasks — Change footprint projection

> Status: SHIPPED (2026-06-24) on branch `feat/change-footprint-projection`.
> Module: `src/core/services/mcp-handlers/change-footprint.ts` (+ co-located test).
> No new MCP tool, no graph-schema change — an internal primitive for `plan_parallel_work` (proposal 2).

## 1. Task descriptor (input contract)
- [x] Define `TaskDescriptor { id, seedSymbols?, seedFiles?, intent?, writeMode? }` (input type only;
      no persistence). Require at least one seed; validate ids are unique within a call.
- [x] `writeMode: 'append' | 'modify'` (default `modify`) — caller-declared per descriptor (or per
      seed); marks pure additions to a registration site. Never inferred.
- [x] When seeds are sparse and `intent` is present, widen seeds via existing semantic search
      (best-effort; never fabricates a write target — only adds candidate seeds the caller declared
      interest in). *Implemented as the injected `opts.extraSeedIds` seam: the caller (proposal 2)
      runs the semantic search and passes candidate ids, keeping the core pure and deterministic.*

## 2. Footprint computation (reuse existing reachability)
- [x] `write-set`: resolve seeds to symbols; normalize to enclosing symbol/type/file. Declared region
      only — no edit prediction. Carry each symbol's declared `writeMode`.
- [x] `read-set`: forward call closure of the write-set, bounded by existing call-distance scoping
      (`buildWeightedAdjacency`/`weightedBfs`) **and** with ambient symbols excluded.
- [x] `affected-set`: backward reachability of the write-set (== `blast_radius`, via the same
      `buildAdjacency`/`bfs` hop-depth traversal `analyze_impact` uses); informational output
      only — NOT a hazard-classification input.
- [x] `coupling-neighbors`: files co-changing with the write-set above `COUPLING_MIN_SUPPORT` /
      `COUPLING_MIN_CONFIDENCE` (thresholds applied at analyze time by the change-coupling store),
      carried as a separate soft annotation via an injected `couplingLookup`.
- [x] Ambient-symbol set: derived from a fan-in percentile (`AMBIENT_FANIN_PERCENTILE = 0.99`,
      configurable); used to filter read-sets and suppress RAW edges. Default documented.
- [x] Unresolved seed → empty footprint + explicit `unresolvedSeeds` note (never a fabricated region).

## 3. Pairwise hazard classifier (pure function)
- [x] `classifyHazard(a: Footprint, b: Footprint)` → `{ kind: WAW|shared-append|RAW|WAR|soft-coupling|none,
      direction?, witnesses }`.
- [x] WAW: `write∩write` with ≥1 side in `modify` mode. shared-append: `write∩write` with BOTH sides
      `append` on every shared symbol. RAW: `write(X)∩read(Y)` (ambient excluded from read membership,
      but a written ambient symbol still counts via `ambientReadDeps`), direction recorded.
      WAR/low-risk: same-file disjoint symbols or read-only overlap. soft: co-change overlap
      with no static relation.
- [x] Strongest-hazard precedence WAW > RAW > shared-append > WAR > soft-coupling > none; include
      witnessing symbols (sorted, deterministic).

## 4. Determinism & honesty
- [x] Deterministic, byte-identical re-evaluation for a fixed (graph, coupling, descriptor) state
      (asserted in unit tests and on the real repo graph in the dogfood).
- [x] Write-set always flagged `advisory: true` with a known-unknowable `disclosure`.

## 5. Tests & fixtures
- [x] write-set expands seed to enclosing scope; affected-set == `blast_radius`(write-set);
      read-set == bounded forward closure with ambient symbols excluded.
- [x] WAW / shared-append / RAW (with direction) / WAR / soft-coupling / none each classified on a
      fixture graph.
- [x] shared-append: two `append`-mode seeds on the same registry symbol → shared-append, NOT WAW;
      same symbol with one `modify` side → WAW.
- [x] ambient exclusion: a high-fan-in symbol in both read-sets does not create a RAW edge; a
      write to it still can.
- [x] Unresolved seed → empty footprint + note.
- [x] Determinism (byte-identical) test.
- [x] **Adversarial regression set (7 cases, added in PR hardening):** WAW outranks RAW (a true
      write-write conflict is never downgraded to ordering); the `extraSeedIds` semantic-search seam
      widens the write-set (and an unresolved candidate is noted); partial resolution still computes a
      full footprint while noting the bad seed; `readMaxDistance` / `affectedMaxDepth` bound the
      forward / backward closures; combined `seedFiles` + `seedSymbols` merge and de-duplicate.

## 6. Verify
- [x] `npm run lint`, `npm run typecheck`, `npm run test:run` (245 files, 4893 pass / 2 skip),
      `npm run build` — all green.
- [x] No new MCP tool registered; `tool-contract.test.ts` unaffected (this proposal adds no tool).

## 7. Docs
- [x] Documented the footprint (write/read/affected/coupling), the declared-not-predicted write-set
      contract, the hazard taxonomy, and the advisory/soundness disclosure (module doc-comments).
      Noted this is an internal primitive consumed by `plan_parallel_work` (proposal 2).
- [x] Dogfood writeup: `DOGFOOD-change-footprint-projection.md` (real 5932-node graph; reproduces the
      validation exercise's `shared-append` on `dispatchTool`).
