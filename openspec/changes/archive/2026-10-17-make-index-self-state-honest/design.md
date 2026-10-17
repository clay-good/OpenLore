# Design

## Context

See `proposal.md` — Why. The relevant current state is that every mechanism this change needs
already exists and is simply not wired to the surfaces that report state:

- `servedRetrievalMode(embedSvc, outputDir, kind)` (`src/core/analyzer/embedder.ts`) already answers
  "what does this index actually serve", by reading `hasEmbeddings` from the meta sidecar. Query
  handlers call it; `doctor` does not.
- `acquireLockAt` (`src/core/runtime/advisory-lock.ts`) already supports a wait policy, a
  dead-PID staleness predicate, and a `LockHeld` descriptor carrying `payload`, `ageMs` and a
  `disclosure`. `withVectorIndexMutation` (`src/core/analyzer/vector-index.ts:593`) discards all of
  it: `throw new Error('Vector index mutation lock is held: ' + lock.lockPath)`.
- `runEmbedStep` (`src/cli/commands/analyze.ts:1022`) catches that error and reports it as
  `⚠ Function index skipped: Semantic index failed; keyword index used`, then the command exits `0`.
  Observed on 2026-09-20: a second `analyze --force` collided with a running build and reported
  success over a keyword-only index.
- `readReusableIndexes` (`src/core/analyzer/analysis-indexes.ts:192`) gates reuse on
  `generationId` + `configurationHash` + index existence. The configuration hash covers
  `config.embedding`, so a config that *names* a provider hashes identically whether or not the
  built index realized it.
- `AnalysisIndexResult.degraded[]` already exists and is written into `analysis-indexes.json`; the
  watcher's embed failures never reach it (`[mcp-watcher] embed error: fetch failed` goes to
  `.openlore/serve.log` only).

## Goals / Non-Goals

**Goals:**

- One source of truth for "what mode is served" across `doctor`, the new status command, and the
  agent-facing lease: `servedRetrievalMode`, never a second derivation.
- Make the three silent paths — reuse, lock contention, watcher embed failure — state what happened
  through data already flowing (`degraded[]`, `LockHeld`), not through new artifacts.

**Non-Goals:**

- No change to the meta sidecar schema, the lock file format, or the index layout. Every fact this
  change reports is already on disk.
- No change to retrieval behavior or ranking. Keyword results stay first-class.
- No automatic rebuild: a mismatch is reported with its remedy; the operator or `analyze` decides.
- No new blocking gate. Nothing here fails a commit or blocks an agent.

## Decisions

**1. `doctor` reports the served mode as its own check, beside the endpoint check — not instead of it.**
The endpoint check is still useful (it caught nothing wrong on 2026-09-20 because nothing *was*
wrong with the endpoint). Replacing it would trade one blind spot for another. Two lines, two
verdicts: `Embedding endpoint` (reachability) and `Retrieval mode` (what the index serves).
*Alternative considered:* fold the endpoint check into the mode check — rejected, because an
unreachable endpoint with a stale-but-vectored index is a different problem from a reachable
endpoint with no vectors, and the operator needs to tell them apart.

**2. Capability agreement is a separate predicate from the configuration hash, not a new hash input.**
Hashing `hasEmbeddings` into `configurationHash` would conflate "what was asked for" with "what was
produced" and would invalidate every existing receipt on upgrade. Instead `readReusableIndexes`
gains one explicit comparison — resolved provider vs. `meta.hasEmbeddings` — evaluated after the
existing checks. Resolving the embedder there is the same call the build path makes moments later,
so it costs nothing extra on the miss path; on the hit path it is one config read.
*Alternative considered:* invalidate on any `hasEmbeddings:false`. Rejected — that would rebuild
forever in the unconfigured keyword default, which is the supported majority case.

**3. Lock contention becomes a typed outcome, not a string error.**
`withVectorIndexMutation` returns/raises a result carrying the holder's pid, the lock age and
whether the holder is alive, so callers can distinguish three cases that today collapse into one
message: held by a live process, held by a dead process (reclaim), and a genuine provider failure.
`analyze` maps them to: wait (under `--wait`), non-zero exit naming the holder, and the existing
keyword-fallback notice respectively. Only the third is a legitimate "keyword index used".
*Alternative considered:* always wait. Rejected — an unbounded wait behind a hung holder is the
failure mode the bounded policy was written to avoid, and `--wait` already expresses that intent
for the analysis lock.

**4. Stale-lock reclamation uses the existing dead-PID predicate, not a TTL.**
A time-based steal would race a slow-but-live build; the existing `isStale` default (dead PID plus
age) is exactly right and already implemented. This change only ensures the vector-index call site
passes a policy rather than accepting the defaults silently, and that the reclamation is *stated*.
A 16-day-old lock from a dead pid was blocking writes precisely because nothing said so.

**5. Watcher embed failures are written into the index receipt's `degraded[]`, with a build stamp.**
That array is already read back by the surfaces that matter and is cleared by the next successful
build, which gives the "recovered build clears the report" behavior for free.
*Alternative considered:* a dedicated `embed-failures.json`. Rejected — a new artifact needs its own
invalidation story, and `degraded[]` already has one.

**6. `openlore status` is a new read-only command, not a flag on `doctor`.**
`doctor` is a multi-check diagnostic with remediation; the question "what mode am I serving right
now" is a one-line lookup an agent or a human asks constantly. Keeping it separate keeps `doctor`'s
cost and output unchanged. The name matches the spec corpus, which already references
`openlore status` in the CLI domain description while no such command exists (`unknown command
'status'`, verified 2026-09-20).

## Risks / Trade-offs

- **A stricter reuse gate causes a surprise rebuild on the first run after upgrade** (any repo whose
  configured provider never materialized) → the rebuild is the correct outcome and happens once;
  the notice states why it rebuilt.
- **Non-zero exit on lock contention may break a script that ran two analyses concurrently and
  tolerated the silent degrade** → that tolerance was the bug; `--wait` is the supported path and is
  named in the error message.
- **Reclaiming a lock whose pid was recycled by an unrelated process** → the predicate requires both
  a dead pid *and* age, and the reclamation is stated in the output, so a wrong reclaim is visible
  rather than silent. Unchanged from the existing default policy.
- **`doctor` gains a finding on repositories that were "green" yesterday** → intended: those
  repositories were serving keyword results under a semantic configuration. The finding names the
  remedy and does not fail any gate.

## Migration Plan

No data migration. Existing `analysis-indexes.json` receipts stay readable; the new predicate can
only invalidate them, which triggers a rebuild — the safe direction. Existing lock files are
readable by the unchanged `acquireLockAt` payload parser. Rollback is reverting the code; no on-disk
state written by this change needs undoing.
