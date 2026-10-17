# Proposal

## Why

OpenLore is honest about the graph it serves but silent about the state of its own index. On
2026-09-20, two repositories (`openlore` itself and `pi-outpost`) had served every `orient` in
keyword mode for days while `doctor` reported `✓ Embedding connection … 384 dims · 1952ms` and the
config named a working endpoint: the endpoint was reachable, the index had no vectors, and nothing
reconciled the two. Four independent silences produced that state — a `doctor` check that tests the
endpoint instead of the index, a build-time embed failure logged only to the daemon's log file, an
index-reuse gate that compares configuration instead of realized capability, and a lock collision
that degraded a `--force` rebuild to keyword and exited `0`. Each is small; together they make the
product's own retrieval mode unknowable without reading `vector-index-meta.json` by hand.

## What Changes

- `openlore doctor` reports the retrieval mode **actually served** (via the existing
  `servedRetrievalMode`), not just endpoint reachability, and raises a finding when a configured
  embedding provider and the on-disk index disagree — the endpoint check keeps its own line.
- A new `openlore status` command prints the index's self-state in one screen: retrieval mode
  served, index build time, staleness against the working tree, and the reason for any keyword
  mode (unconfigured default vs. configured-but-unrealized).
- The index-reuse gate (`readReusableIndexes`) invalidates a receipt whose realized capability
  contradicts the configuration: a resolvable embedder plus `hasEmbeddings:false` on disk is a
  mismatch, so `analyze` (and `--reanalyze`) rebuilds instead of reusing a keyword index forever.
- A vector-index mutation lock held by another process no longer silently degrades the build to
  keyword: `analyze` waits for the lock under the existing `--wait` flag, and otherwise fails with
  a non-zero exit naming the holding pid and the age of the lock.
- A lock whose recorded pid is dead is reported as stale and cleared, rather than blocking index
  builds indefinitely (a lock from 2026-09-04 was still refusing writes on 2026-09-20).
- Build-time embed failures in the watcher reach the agent surface: the existing one-time
  configured-but-unreachable notice is recorded in the index receipt's `degraded[]` so `doctor`,
  `status`, and `orient`'s lease can state it, instead of living only in `.openlore/serve.log`.

Keyword mode stays a first-class default. Nothing here reframes it as degraded — the change is
about a *configured expectation that silently did not happen*, which the specs already call out as
notice-worthy.

## Capabilities

### New Capabilities

(none — every behavior below extends an existing capability)

### Modified Capabilities

- `cli`: `RetrievalModeIsStatedPlainlyAndLowNoise` gains the served-mode-vs-configured-mode
  reconciliation and the `openlore status` surface; `DoctorsConfigVerdictIsSupportedByItsEvidence`
  and `DoctorAndTheCommandsAgreeAboutConfiguration` extend from configuration to the realized index
  (a `doctor` pass must not contradict what retrieval actually serves).
- `analyzer`: `VectorIndexCacheCoherence` gains capability-mismatch invalidation of the index-reuse
  receipt, and `SerializeSpecificationIndexAccessWithAnAdvisoryLock` gains the stale-lock and
  lock-contention rules (wait, or fail loudly — never a silent keyword downgrade).
- `config`: `KeywordIndexIsAFirstClassDefaultNotADegradedFallback` gains the distinction the current
  wording leaves implicit — an *unconfigured* keyword index is the first-class default, while a
  *configured but unrealized* semantic index is a reportable finding, not a default.

## Impact

- `src/cli/commands/doctor.ts` — served-mode check, config/index mismatch finding
- `src/cli/commands/status.ts` — new command (registered in `src/cli/index.ts`)
- `src/core/analyzer/analysis-indexes.ts` — `readReusableIndexes` capability check, `degraded[]`
  propagation into the receipt
- `src/core/analyzer/vector-index.ts` — lock acquisition: stale-pid detection, contention result
- `src/cli/commands/analyze.ts` — `runEmbedStep` exit signal on lock contention, `--wait` plumbing
- `src/core/services/mcp-watcher.ts` — embed failures recorded in the receipt, not only logged
- `src/core/analyzer/embedder.ts` — unchanged; `servedRetrievalMode` is the reused source of truth
- No schema change to `vector-index-meta.json`; no new artifact
