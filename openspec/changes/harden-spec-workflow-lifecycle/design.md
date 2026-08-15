## Context

The current mapping generator consumes LLM pipeline operations and persists the result as global `mapping.json`; audit and Repair then treat that optional output as provenance. Composite responses separately cap item counts and 220 KiB payloads, while Pi still clips model-visible text at 50,000 characters. Analysis artifacts are written individually, daemon context caching is primarily mtime-based, and no repository-wide full-analysis lock coordinates CLI, MCP, and Pi processes.

The existing architectural boundary remains unchanged: OpenLore produces deterministic observations; the host agent interprets business meaning and edits specs. This design strengthens that boundary rather than adding an OpenLore spec-writing agent.

## Goals / Non-Goals

**Goals:**

- Make mapping-dependent observations derivable from current specs and analysis without an LLM or a prior Generate run.
- Ensure unknown, partial, stale, and truncated evidence is machine-distinguishable from observed empty evidence.
- Give every bundled host one transport-safe, resumable composite protocol.
- Make a full analysis single-flight, atomically published, automatically reloaded, and visibly alive.
- Align standalone and agent-hosted workflow outcomes while preserving their different prose authors.

**Non-Goals:**

- Inferring business intent from file names, requirement prose, or similarity scores.
- Adding an MCP file editor or moving specification authorship into OpenLore.
- Treating file-only spec references as proof that every function in a file is covered.
- Making runtime lock/heartbeat timestamps part of deterministic analysis artifacts.
- Removing standalone provider-backed generation.

## Decisions

### 1. Replace pipeline mapping with a deterministic versioned link index

Introduce a pure link-index builder that parses each requirement block with the canonical spec parser, normalizes explicit source and implementation references, and resolves exact symbols against the current graph. The persisted artifact remains `mapping.json` for compatibility but receives a new schema version and provenance containing the committed analysis generation plus a digest of all parsed specs.

Resolution is intentionally conservative:

- exact path + exact symbol with one graph identity → `linked`;
- multiple exact identities → `ambiguous` with bounded candidates;
- explicit identity absent from the graph → `stale`;
- no exact symbol anchor → `unmapped` (file anchors remain domain-footprint evidence).

Name similarity and embeddings may be exposed later as non-authoritative suggestions, but never as coverage. Audit and Repair call the pure builder when the cache is absent or incompatible; `mapping refresh` only materializes that result.

Alternative considered: retain LLM/semantic fallback and label confidence. Rejected because Repair availability would still depend on prior probabilistic generation and “covered” would remain an inference rather than an observation.

### 2. Make availability binary and put detail in stable reason codes

Normalize mapping coverage to `available | unavailable`. Legacy distinctions such as missing, stale, and invalid move to stable `reason` values. Every mapping-dependent numeric field becomes nullable. This is a deliberate API schema change; consumers must branch on availability before arithmetic.

Alternative considered: keep zero plus a warning. Rejected because generic agents and dashboards routinely interpret numeric zero without reading adjacent prose.

### 3. Page a canonical evidence stream under a 48 KiB default

Represent each workflow response as an ordered stream of logical evidence records (metadata, domain membership, signatures, each inventory family, relationships, spec segments, mapping observations, drift, structural changes, overlaps). Pack records until the serialized envelope approaches the effective byte budget. The cursor records the stream section and offset rather than only a file offset.

The public input accepts `maxResponseBytes`, capped by the server maximum; the default is 48 KiB so every bundled adapter can carry it below Pi's current 50,000-character boundary. Cursor fingerprints bind the effective budget and protocol version. Adapters must bypass generic truncation for a valid within-budget composite; a defensive adapter failure returns a typed transport error rather than clipped JSON.

Alternative considered: token-only budgeting. Rejected because tokenizers vary by host/model and cannot guarantee transport byte limits. An approximate token count may be reported, but serialized UTF-8 bytes are the enforcement unit.

### 4. Keep continuation inside the two default composites

Volume-driven recovery uses the same `prepare_spec_generation` or `prepare_spec_repair` tool with its opaque cursor, both guaranteed in the default substrate. Unavailable-state remediation uses a typed action union: `mcp` only for a tool known active, `cli` for an exact local command, and `edit` for an explicit-anchor correction the host must author. Receipt construction validates actions against the active tool set supplied by the transport.

Alternative considered: add every atomic follow-up to the default preset. Rejected because it substantially increases tool-schema cost and repeats a selection problem the composites were introduced to remove.

### 5. Publish analysis through a generation manifest

Each full analysis chooses a random generation id and writes candidate artifacts to staging using existing atomic file writers. Publication writes a manifest containing required artifact paths and digests, then atomically makes that manifest current. Multi-artifact readers read the current manifest, load and verify artifacts, and re-read the current identity before returning. A changed identity triggers one retry, then a typed `analysis-changed` response.

Caches key by canonical repository path plus generation id, not only artifact mtime. Legacy analysis without a manifest remains readable through a disclosed compatibility generation and is upgraded on the next analyze.

Alternative considered: rename the entire analysis directory. Rejected because databases, runtime sidecars, and platform-specific rename behavior make whole-directory replacement unnecessarily risky.

### 6. Use one cross-process analysis lock and progress sidecar

Acquire a lock with exclusive creation under the repository runtime state before any full rebuild. The lock records canonical repository identity, PID, start, heartbeat, stage, and progress-file location. The owner atomically refreshes a separate progress sidecar at least every 15 seconds; CLI rendering emits a visible heartbeat at least every 30 seconds during unchanged long phases. Normal exit and signals release ownership. Reclamation requires both a dead PID and heartbeat older than the threshold.

`analyze --wait` follows the sidecar until the owner publishes or fails. The same lock service is used by CLI, MCP, daemon bootstrap, and Pi.

**This is not a second locking mechanism.** `src/core/decisions/lock.ts` already owns the repository's single advisory-lock loop (`acquireLockAt`), whose header states the rule explicitly: both existing callers — `acquireDecisionsLock` and `acquireAnalysisLock` (`.artifacts.lock`, from `harden-artifact-write-atomicity`) — are thin bindings of one loop, "no second locking mechanism, no new tuning values". Analysis ownership becomes the **third thin binding of that same loop**, not a parallel implementation. The loop is parameterized rather than copied; every field below already exists as a hardcoded behavior of `acquireLockAt`:

| Policy knob | Default (existing two callers, unchanged) | Ownership binding |
|---|---|---|
| `payload` | `` `${pid} ${iso}` `` plain text | structured JSON: canonical repo identity, PID, start, heartbeat, stage, progress-file path |
| `isStale` | `mtime > STALE_MS` | dead PID **and** heartbeat older than the threshold (PID-reuse defense) |
| `onContended` | `wait` (poll `POLL_MS`) | `report` — return the owner descriptor so the caller emits `ANALYSIS_IN_PROGRESS`; `wait` only under `analyze --wait` |
| `bestEffortAfterMaxWait` | `true` — proceed unlocked after `MAX_WAIT_MS` rather than hang a background write | **`false`** — proceeding unlocked would silently void the single-flight guarantee this decision exists to provide |
| heartbeat refresh | none (mtime frozen at create) | owner rewrites the payload on the sidecar cadence |

Consequences of that choice: no new lock loop, no new stale-steal path, no new release path — the idempotent-unlink release and the exclusive-create acquire are the existing ones. The one genuinely new tuning value is the ownership heartbeat/stale threshold, and it is declared in the same constants block as `STALE_MS`/`POLL_MS`/`MAX_WAIT_MS` so tuning values stay in one place. Because `lock.ts` now serves three unrelated domains, it moves out of `src/core/decisions/` to a neutral module (both faces import it; `artifact-write-atomicity.test.ts` asserts the import path literally and is updated in the same task).

The ownership lock and `.artifacts.lock` are **complementary, not redundant**, and neither can absorb the other: ownership is held for a whole analysis run and is what a competing *analysis* contends on; `.artifacts.lock` fences only the artifact write-set and is also taken by the incremental watcher, which never takes ownership. Collapsing them would either serialize every watcher persist against a full analysis run or leave artifact writes unfenced. An owner therefore takes ownership **before** `.artifacts.lock` and never the reverse — one fixed order, so the two can never deadlock. Lower-level database/write locks remain below both as defense in depth.

Alternative considered: process-local promise deduplication. Rejected because the observed duplicate analyses run in distinct processes and frontends.

Alternative considered: use `acquireAnalysisLock` as-is for ownership. Rejected — its `bestEffortAfterMaxWait` escape hatch means a contender proceeds anyway after `MAX_WAIT_MS`, which is correct for a bounded artifact write but is exactly the duplicate full analysis this decision must prevent; and its mtime-only staleness cannot express dead-PID-plus-stale-heartbeat.

### 7. Compute spec overlap as evidence, not domain reconciliation

Build existing spec footprints from canonical source headers, implementation references, and exact link-index symbols. Compare them with the requested reconciled domain footprint and return shared files/symbols plus completeness/provenance. No score automatically suppresses or promotes a domain. The Generate skill must stop for host judgment when material overlap exists rather than silently creating a competing spec.

Alternative considered: maintain another global denylist for technical domain names. Rejected because names such as `components` can be legitimate business boundaries and the earlier domain-scope work explicitly moved away from stacked denylist mechanisms.

### 8. Finalize both authoring paths through the written specs

Standalone generation first writes candidate specs, then derives mapping from those files. Agent-hosted skills validate their edit and invoke `mapping refresh` when shell access is available; otherwise they report that persistence was skipped. Because audit/Repair derive in memory, correctness is independent of the final cache write.

The skill names remain `openlore-generate` and `openlore-repair`: they describe the user outcome, while `prepare_` continues to distinguish read-only MCP evidence tools.

### 9. Split real preview from cheap planning

Keep the established early-return behavior on `--dry-run`, and expose `--plan` as a more explicit alias. Neither mode resolves or constructs a provider. A separate `--preview` executes the normal provider pipeline with every project-target path redirected to a temporary workspace, then calculates a normalized summary of candidate spec changes. Mapping, configuration, manifests, backups, and analysis outputs are also redirected or disabled. Temporary output is removed after rendering. Preview does not claim to render changes to those supporting artifacts.

Alternative considered: change `--dry-run` into the paid preview. Rejected because existing callers rely on it as the free planning contract; silently turning an established free command into a billable operation is unsafe.

## Risks / Trade-offs

- **[Legacy specs have few exact symbol anchors]** → Report them as unmapped and update canonical skills/templates to add per-requirement implementation anchors; never inflate coverage from file-only references.
- **[Mapping schema breaks old consumers]** → Version the artifact, keep a compatibility reader for provenance/error reporting, and regenerate rather than migrate probabilistic links.
- **[48 KiB increases round trips for large domains]** → Stream deterministic sections without repeating page-global evidence and let callers request a smaller, never larger-than-server, budget.
- **[Manifest validation adds reads/hashing]** → Hash at publication, store digests, and validate generation identity cheaply on hot paths; perform full digest verification on cache misses or integrity suspicion.
- **[Stale lock recovery can target PID reuse]** → Require both stale heartbeat and repository/owner metadata validation; never reclaim solely by elapsed time.
- **[Parameterizing the shared lock loop regresses its two existing callers]** → Every new knob defaults to the current hardcoded behavior, so `acquireDecisionsLock`/`acquireAnalysisLock` change call sites not at all; the existing `lock.test.ts` cases are the regression gate and must pass unmodified except for the import path.
- **[Preview incurs provider cost]** → Give the paid operation a distinct `--preview` name and display the estimate and explicit cost warning; `--dry-run` and `--plan` remain free.
- **[Overlap evidence can be large]** → Feed it through the same receipted evidence stream and rank exact-symbol intersections before file-only intersections.

## Migration Plan

1. Add nullable audit types and deterministic link-index types/builders while retaining legacy mapping reads as unavailable provenance.
2. Add `mapping refresh`; switch audit and Repair to in-memory derivation, then switch standalone generation finalization.
3. Replace composite file pagination with evidence-stream pagination and lower the default transport budget; update Pi and skill conformance tests.
4. Add overlap observations and executable remediation actions.
5. Introduce generation manifests and generation-keyed caches with legacy fallback.
6. Add the shared full-analysis lock/progress service and wire CLI/MCP/Pi entry points.
7. Update canonical skills, preserve free `--dry-run`/`--plan`, and add paid `--preview`.
8. Dogfood Analyze → Generate → Repair on the reported external project, including stale mapping, oversized `components`, daemon reload, concurrent analyze, and long artifact generation.

Rollback can disable manifest publication, lock attachment, and deterministic cache persistence independently. Existing specs are never deleted; new mapping caches and incomplete staging generations are disposable.
