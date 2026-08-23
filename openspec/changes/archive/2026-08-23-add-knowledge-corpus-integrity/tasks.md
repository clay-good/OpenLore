# Tasks — add-knowledge-corpus-integrity

## Implementation
- [x] `src/core/decisions/corpus-integrity.ts`: `CORPUS_EDGE_REGISTRY` in the
      `FINDING_CODE_REGISTRY` style (`enforcement-policy.ts`) — each edge declares source artifact
      type, target range, directionality, cycle rule, live-source-to-retired-target rule
- [x] Resolver over the artifacts already on disk: `openspec/specs/<domain>/spec.md` requirements
      and their `> Decision recorded:` lines (written by `src/core/decisions/syncer.ts`),
      `openspec/changes/*/specs/<domain>/`, the decision store (`src/core/decisions/store.ts`)
      including `supersedes`, and the memory store's decision citations and symbol anchors
- [x] Fold the existing memory verdict in rather than reimplementing it: `stale-decision-reference.ts`
      becomes the `memory-cites-decision` edge's evaluator, and the spec face reuses it
- [x] Emit findings in the unified `GovernanceFinding` shape; register
      `corpus-reference-unresolved`, `corpus-reference-ambiguous`, `corpus-self-reference`,
      `corpus-duplicate-identifier`, `corpus-edge-unsupported`, `corpus-target-type-mismatch`,
      `corpus-target-retired`, `corpus-supersession-cycle`, `corpus-anchor-target-missing`,
      `corpus-reference-undeclared` in `enforcement-policy.ts` with source-declared default classes
- [x] Supersession-cycle detection: cycle members are reported and NONE of them is presented as
      authoritative by `verify_claim decision-current` while the cycle stands
- [x] Undeclared-reference detector: exact id / exact requirement-name matching only; excludes
      fenced blocks, declared-reference lines, self-references, and already-declared targets;
      at most one finding per (source, target); writes nothing
- [x] Surface in `src/cli/commands/doctor.ts` (corpus section) and as a finding source in
      `src/cli/commands/enforce.ts`. No new MCP tool
- [x] Registry-closure guard test in the `tool-contract.test.ts` style: an unregistered edge kind
      or an unregistered finding code fails CI

## Verification
- [x] Fixture corpus per finding code: each fires on the artifact that violates it and stays
      silent otherwise
- [x] Retired-target: a live requirement citing a superseded decision reports
      `corpus-target-retired` and names the superseder; re-pointing it clears the finding
- [x] Cycle: A supersedes B supersedes A reports every member; `verify_claim decision-current`
      returns `unverifiable` (never a confident verdict) for ids inside the cycle
- [x] Duplicate identity: two same-named requirements in one domain report the duplicate AND make
      every inbound reference ambiguous
- [x] Undeclared-reference precision: a fenced-code occurrence, a self-reference, and an
      already-declared target each produce no finding; no file on disk is modified by the run
- [x] Determinism: two runs on unchanged corpus bytes produce byte-identical ordered findings; no
      network access occurs
- [x] Policy: a downgrade entry moves a finding to advisory without changing which findings exist;
      an absent policy is a pure no-op over the source-declared defaults
- [x] Full suite green, including the existing memory stale-decision-reference tests, which must
      keep passing unchanged after the fold-in

## Spec
- [x] `openspec` delta: ADD CorpusEdgesAreDeclaredAndResolved and
      UndeclaredCorpusReferencesAreSuggestedNeverWritten
- [x] Cross-reference in the proposal trail: `add-corpus-change-intent-review` owns corpus deltas
      between refs; `check_spec_drift` owns spec-to-code; `add-enforcement-baseline-ratchet` owns
      the adoption ramp for the blocking defaults
