## 1. Domain evidence and survey

- [x] 1.1 Add a bounded deterministic domain-evidence builder from `RepoStructure`, `LLMContext`, graph/skeleton data, with a stable fallback bundle for undomained files and stable partitioning for oversized domains; expose that same representation to standalone, MCP and Pi consumers without re-deriving structural facts.
- [x] 1.2 Refactor stage 1 to derive downstream file/domain membership from domain evidence, make its LLM work aggregate semantic metadata only, and remove chunk merge/highest-confidence file classification.
- [x] 1.3 Update pipeline orchestration, intermediate-result compatibility and focused tests for deterministic stage-1 output and stage resume behavior.

## 2. Domain-aggregated extraction

- [x] 2.1 Refactor stage 2 to make one reconciled entity extraction per domain evidence bundle, preserving inventory-derived entity locations, fields and types.
- [x] 2.2 Refactor stage 3 to make one reconciled service extraction per domain bundle, preserve exact inventory signatures in `functionName`, and retain hierarchical sub-spec generation.
- [x] 2.3 Refactor stage 4 to make one reconciled endpoint extraction per domain bundle and emit only route-inventory method/path identities.
- [x] 2.4 Add unit and integration coverage for cross-file domains, duplicate semantic outputs, invalid structural LLM references, undomained files and deterministic large-domain partitioning.

## 3. Mapping and honest coverage state

- [x] 3.1 Version `MappingArtifact`, persist the deterministic source-analysis fingerprint, and adapt `MappingGenerator` plus its tests to reconciled domain-aggregated service output.
- [x] 3.2 Add `mappingCoverage` availability state and reason to the audit API/types; withhold mapping-derived coverage claims for missing, malformed or fingerprint-stale artifacts while retaining stale-domain results.
- [x] 3.3 Update audit CLI and MCP handler/contract tests to display degraded coverage truthfully and provide a refresh/remediation hint.

## 4. Agent-neutral workflow

- [x] 4.1 Update generation, repair and MCP documentation to define the provider-neutral Generate/Repair composition and replace Claude Code-specific architectural wording with MCP-compatible host agent terminology.
- [x] 4.2 Add an end-to-end fixture proving a non-client-specific MCP workflow can retrieve the documented evidence and distinguish consistent, structural-change, uncovered and unavailable-coverage observations.
- [x] 4.3 Add native Pi Generate and Repair entry points over the existing warm daemon, using the task-specific compositions and Pi's ordinary editing workflow without duplicating OpenLore evidence logic.
- [x] 4.4 Extend Pi surface-parity tests to require every Generate/Repair observation or a documented exclusion, and cover Pi's degraded `mappingCoverage` presentation.

## 5. Verification

- [x] 5.1 Run the affected generator, mapping, audit and MCP test suites and fix regressions.
- [x] 5.2 Run `openlore generate` for a representative real domain using the configured provider; compare its output with the pre-refactor baseline for structural completeness and mapping validity.
- [x] 5.3 Validate the OpenSpec change artifacts and record any provider context-limit observations before implementation handoff.

## Resume notes — 2026-08-10

- All affected generator, mapping, audit and MCP tests pass (214 tests), the
  agent-neutral MCP fixture passes, and the full Pi suite passes (53 tests) when
  loopback access is available. `npm run typecheck` and `npm run build` pass.
- The four prior `handleDetectChanges` failures were fixture isolation bugs:
  global `commit.gpgsign=true` prevented their baseline commits. Each fixture
  now disables signing explicitly.
- A real configured-provider run completed for `generator` only: stage 2 used
  3 generator partitions, stage 3 used 10, API extraction had no in-scope files,
  and the pipeline consumed 355,503 tokens in 7m49s. The output contained 86
  requirements and 324 scenarios versus 60 and 112 in the baseline. The v2
  mapping mapped 263/263 generated requirements and audit reported
  `mappingCoverage.state=available`.
- Provider observations: Codestral required several JSON-correction passes and
  the generated spec still reported two Given/When/Then validation errors plus
  many requirement-prose warnings. The run also exposed and fixed two domain
  scope leaks (all-domain evidence and semantic fallbacks) and an absolute
  `--output-dir` rebasing bug. Generated baseline files were restored after the
  comparison.
- Remaining: final full verification, strict OpenSpec validation, and diff review.
