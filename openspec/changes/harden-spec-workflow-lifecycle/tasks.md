## 1. Deterministic Link Index Foundation

- [x] 1.1 Record the architectural decisions for deterministic mapping, evidence-stream pagination, generation manifests, and repository-scoped analysis ownership before source edits.
- [x] 1.2 Add versioned deterministic link-index types, explicit coverage-availability types, provenance fields for analysis generation plus spec digest, and compatibility parsing for legacy mapping artifacts.
- [x] 1.3 Extend the canonical spec parser to return requirement-scoped normalized file and exact-symbol anchors without treating arbitrary prose or file-only references as function coverage.
- [x] 1.4 Implement the pure spec-link-index builder with `linked`, `ambiguous`, `unmapped`, and `stale` states, bounded candidate disclosure, stable ordering, and no LLM/vector/name-similarity fallback.
- [x] 1.5 Add unit fixtures for exact links, duplicate symbols, deleted symbols, path normalization, file-only anchors, requirements without anchors, malformed specs, and deterministic spec digests.

## 2. Mapping Refresh And Audit Honesty

- [x] 2.1 Add `openlore mapping refresh` with current-analysis validation, persisted versioned output, concise state counts, bounded ambiguity output, and a strict ambiguity exit option.
- [x] 2.2 Make audit and Repair derive the current link index in memory when the persisted cache is missing, legacy, invalid, or provenance-incompatible; keep persistence optional on read-only paths.
- [x] 2.3 Make MCP/composite audit summaries use `null` for unavailable mapping-dependent values while preserving the public v2 API's numeric summary contract.
- [x] 2.4 Update API, CLI, MCP, viewer/consumer types and rendering to branch on `mappingCoverage.state` before interpreting mapping-dependent metrics.
- [x] 2.5 Switch standalone generation finalization to derive mapping from the specs it actually wrote, and remove LLM/semantic/heuristic matches as authoritative coverage inputs.
- [x] 2.6 Add end-to-end tests for missing/stale/legacy mapping, cache-free Repair, explicit-anchor repair, standalone finalization, and refresh idempotence.

## 3. Transport-Safe Generate And Repair Composites

- [x] 3.1 Replace file-offset cursors with a versioned logical evidence-stream cursor bound to workflow, domain, analysis generation, section, offset, effective byte budget, and protocol version.
- [x] 3.2 Add `maxResponseBytes` to both MCP composite schemas, enforce a 48 KiB default and server maximum, and pack serialized UTF-8 records without exceeding the effective budget.
- [x] 3.3 Page independently through domain membership, signatures, every inventory family, relationships, existing spec segments, mapping observations, drift, structural changes, and overlap evidence without repeating complete page-global sections.
- [x] 3.4 Guarantee `partial` plus a continuation cursor for every recoverable omission, `complete` only after the final bounded page, and a typed unrecoverable error for an indivisible record that cannot be represented safely.
- [x] 3.5 Replace generic Pi clipping for composite envelopes with protocol-aware forwarding/error handling and align Codex/MCP/Pi conformance tests to the same serialized byte bound.
- [x] 3.6 Add oversized single-file, multisection, multibyte UTF-8, forged/stale cursor, exact-boundary, and exhaust-all-pages regression tests that concatenate to the unpaged canonical evidence stream.

## 4. Executable Remediation And Domain Overlap

- [x] 4.1 Replace unvalidated atomic follow-ups with a typed `mcp | cli | edit` remediation union and validate MCP actions against the active tool surface before returning a receipt.
- [x] 4.2 Use same-composite cursors for volume recovery and emit exact `openlore mapping refresh` or explicit-anchor remediation when mapping is unavailable; never recommend repeating the unavailable audit.
- [x] 4.3 Build existing spec footprints from canonical source references and deterministic exact links, then compute bounded shared-file/shared-symbol observations for generation candidates.
- [x] 4.4 Add overlap evidence and completeness receipts to generation preparation without suppressing, renaming, merging, or promoting a domain automatically.
- [x] 4.5 Update the Generate skill to pause for host judgment on material existing-spec overlap and add tests for `components` overlapping several existing specs plus a complete empty-overlap case.

## 5. Atomic Analysis Generations And Cache Reload

- [x] 5.1 Add an analysis-generation manifest schema with generation id, required-artifact digests, compatibility state, and durable atomic manifest publication.
- [x] 5.2 Serialize the complete required artifact write set and manifest commit point; fail closed as `analysis-changed` after an interrupted in-place replacement rather than claiming the overwritten prior generation remains readable.
- [x] 5.3 Add a consistent multi-artifact snapshot reader that validates the current generation before and after reads, retries once on change, and otherwise returns typed `analysis-changed`.
- [x] 5.4 Key context, traversal, edge-store, preflight, and composite caches by canonical repository plus committed generation id, retaining disclosed legacy fallback until the next analyze.
- [x] 5.5 Add daemon regression tests where an external analyze replaces old `web/src` paths, concurrent publication occurs during `orient`, and mixed-generation artifacts are rejected.

## 6. Repository-Scoped Analysis Ownership And Progress

- [x] 6.0 Parameterize the shared advisory-lock loop (`acquireLockAt`) with `payload`, `isStale`, `onContended`, and `bestEffortAfterMaxWait`; fail closed by default, serialize namespace changes, and never reclaim a live PID or proceed unlocked for correctness-sensitive writers.
- [x] 6.1 Implement the full-analysis ownership lock as a third thin binding of that loop: canonical repository identity, PID/start/heartbeat/stage/progress-path JSON payload, `onContended: report` (and `wait` only under `--wait`), `bestEffortAfterMaxWait: false`, signal-safe release, and dead-PID-plus-stale-heartbeat reclamation. Declare the ownership heartbeat/stale threshold in the same constants block as `STALE_MS`/`POLL_MS`/`MAX_WAIT_MS`. An owner acquires ownership before `.artifacts.lock`, never the reverse.
- [x] 6.2 Wire CLI analyze, MCP analyze/bootstrap, daemon, and Pi entry points through the shared lock so only one full analysis can run per repository across frontends.
- [x] 6.3 Add atomic progress-sidecar updates at most 15 seconds apart during every stage and visible CLI/attached heartbeats at most 30 seconds apart during unchanged long artifact generation.
- [x] 6.4 Add `analyze --wait` attachment and status/preflight reporting that distinguishes `FRESH`, `STALE`, `MISSING`, and `ANALYSIS_IN_PROGRESS` with owner and elapsed metadata.
- [x] 6.5 Add multiprocess tests for five concurrent invocations, wait attachment, live owner, stale dead owner, PID-reuse defense, signal cleanup, and an 18-minute-equivalent silent-stage fake-clock heartbeat.

## 7. Workflow Finalization And Real Preview

- [x] 7.1 Update canonical `openlore-generate` and `openlore-repair` skills to add exact per-requirement implementation anchors, validate edits, refresh mapping when CLI access exists, and disclose skipped cache persistence without weakening later correctness.
- [x] 7.2 Update setup/package conformance tests so every installed host receives the same finalization and continuation protocol; resynchronize the global test installation only after canonical sources pass.
- [x] 7.3 Preserve the free generate `--dry-run` contract and expose the same plan-only behavior under `--plan`, including CLI/API regression coverage before provider resolution.
- [x] 7.4 Implement explicit paid `generate --preview` in isolated temporary output with provider/cost disclosure, normalized candidate-spec summary, and zero writes to project specs, mapping, configuration, manifests, backups, or analysis artifacts.
- [x] 7.5 Add snapshot/integration tests for dry-run/plan without provider calls, paid-preview candidate diffs, external output directories, provider failure cleanup, and byte-identical project state before/after preview.
- [x] 7.6 Close the unvalidated-finalization hole 7.1 left open, at parity across BOTH authoring paths: give each a format reference OpenLore does not own — an existing baseline spec in the corpus, judged by `openspec validate`, explicitly NOT the CLI's change-delta instructions, disclose on every Repair page that OpenLore validated nothing, name the exact `openspec validate` command as a terminal-page follow-up, report an OpenSpec package resolving from neither scope as unresolved rather than absent, and require the host to report an unvalidated edit as NOT validated.
- [x] 7.7 Stop the workflows offering documentation as behavior: classify prose (docs, licences, project meta) as `supporting` so a documentation-only tree is dropped by the existing `non-defining-only` rule, disclose a symbol-free domain as having no behavior with its supporting counts, emit a terminal-page stop-and-ask follow-up, and make both canonical skills refuse to paraphrase prose into SHALL statements.
- [x] 7.8 Honor the configured specification root in spec retrieval, spec-domain discovery, their reported paths and provenance, and the prose-evidence corpus filter (normalizing a `./`-prefixed root), and disclose validation as unavailable for a relocated corpus the CLI cannot locate, so a repository that moved `openspec/` can load and repair its specifications instead of reporting them not found.
- [x] 7.9 Harden configured-root compatibility by routing Repair and MCP retrieval through the existing repository-confined resolver, supporting a corpus rooted at `.`, and covering conventional extensionless project documentation without classifying lower-case executables as prose.

## 8. Validation And Dogfood

- [x] 8.1 Run focused mapping, audit, composite, MCP preset, Pi, daemon/cache, analyzer-lock, generate, API, and skill suites plus typecheck and lint.
- [x] 8.2 Run full tests and build, inspect `git diff HEAD`, and complete the required code-review agent pass; fix all CRITICAL/HIGH findings and report remaining MEDIUM/LOW findings. (7360 tests green; review returned 13 findings — 5 HIGH and 7 MEDIUM fixed, 2 LOW documented in the PR.)
- [x] 8.3 Dogfood Analyze → mapping refresh → Repair and agent-hosted Generate on the external project that produced the feedback, exercising stale provenance, oversized `components`, existing-spec overlap, daemon reload, concurrent analyze, heartbeat, and real preview.
  - **Exercised on pi-outpost:** legacy/incompatible mapping provenance (reported `available` + `derived`, never a misleading 0%); cache-free Repair on four domains (`theme`, `preview-file-attachments`, `agent`, `file`) taking the link index from 17 linked / 10 stale to **27 linked / 0 stale**; `openlore mapping refresh`; concurrent analyze (second invocation reported the live owner and did no work); stale reclamation after a `kill -9` (dead PID + stale heartbeat); signal cleanup; generation-manifest publication and digest binding; daemon reload against an externally published generation.
  - **Found by dogfooding, not by tests:** the ownership heartbeat never beat during a long synchronous stage (405s frozen), because timers are event-loop callbacks — fixed with an out-of-loop `worker_thread` watchdog. The pre-existing "18-minute silent stage" test had passed throughout: it drove `update()` itself, simulating the very cadence that fails in production.
  - **NOT exercised — paid `generate --preview`.** It runs the actual provider pipeline and costs real money on someone else's account. Free `--dry-run`/`--plan` behavior was verified instead. This is an owner's call, deliberately left undone rather than silently skipped.
- [x] 8.4 Update user-facing MCP/CLI/skill documentation and the PR description with deterministic mapping, nullable coverage, transport-safe continuation, lifecycle observability, preview cost, limitations, and migration guidance.
