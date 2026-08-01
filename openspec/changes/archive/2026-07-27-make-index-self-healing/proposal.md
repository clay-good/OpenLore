# Make the index self-healing: staleness triggers repair, not just disclosure

> Status: SHIPPED (2026-07-18, PR #225; status reconciled 2026-07-19). Originally proposed (2026-07-18). The substrate is excellent at *detecting* a bad index —
> attestation verdicts, an explicit stale region, tokenizer/schema stamps, doctor's age
> warning — and then it stops. Repair is always a human running `openlore analyze`, or a
> post-commit hook they may never have installed. For a tool whose promise is "background
> plumbing that just works," detection without repair is the gap users actually feel:
> "the index / semantic search isn't up to date." This change closes the loop: every
> staleness signal that today only produces a warning becomes a trigger for the same
> at-most-once, non-blocking background rebuild the cold-start bootstrap already proved out
> — with honest disclosure while the repair runs.

## The gap

- **The bootstrap only fires on *absent*, never on *stale*.** `hasAnalysis` checks that
  `llm-context.json` exists (`src/core/services/cold-start-bootstrap.ts:32-34`); an index
  that is weeks old, `mismatched`, or schema-skewed never triggers it.
- **Read paths detect and shrug.** `computeIndexIntegrity`
  (`src/core/services/mcp-handlers/utils.ts:32-47`) yields
  `healthy | degraded | mismatched`; the edge store exposes an explicit stale region
  (`markFilesStale`/`getStaleFiles`, `src/core/services/edge-store.ts:887-926`); the BM25
  corpus refuses a tokenizer-skewed sidecar (`deserializeBm25Corpus`,
  `src/core/analyzer/vector-index.ts:325-343`). All of these end in a verdict attached to
  the response — none starts a repair. The one exception (a WAL checkpoint retry on first
  `degraded`) repairs WAL state only.
- **Call-graph freshness hangs on a hook most users don't have.** The watcher deliberately
  never rebuilds the call graph (`src/core/services/mcp-watcher.ts:6-10`); it stays current
  only via the post-commit hook (`analyze --force --embed`) — which is wired by
  `openlore setup`, not by `install`. The advertised one-command path therefore yields a
  graph that silently ages with every commit.
- **Doctor diagnoses and hands you homework.** Every `doctor` check is read-only with a
  `fix:` hint (`src/cli/commands/doctor.ts:470-490`) — including the historical
  `.claude/settings.json` mis-wire it can detect but not repair.

## What changes

1. **Generalize the cold-start bootstrap into one background repair service**
   (`repairInBackground`, same file, same guarantees: at-most-once per process per repo,
   never blocks, never throws, `OPENLORE_NO_AUTO_ANALYZE`/`autoInit:false` respected).
   Triggers, evaluated on read where the signals already exist:
   - integrity `mismatched` (attestation reconciliation);
   - stale region above a fixed threshold, or any stale file older than a fixed age;
   - schema or tokenizer stamp mismatch (today: silent rebuild of the corpus only —
     unchanged — but a *graph* schema wipe already latches a full rebuild; unify both
     through this service);
   - analysis age beyond `ANALYSIS_AGE_WARNING_HOURS` (doctor's own threshold).
2. **Honest disclosure while healing.** A response served from a stale index during repair
   SHALL carry the existing staleness verdict *plus* "background refresh started" — never
   presented as fresh, never blocked waiting. Reuses the ReadyOrHonestFirstUse conclusion
   shape; *absent* vs *stale* stay distinct.
3. **Call-graph freshness without the hook.** The watcher (or serve daemon) schedules a
   debounced background full `analyze` when (a) the stale region crosses the budget the
   incremental closure already computes, or (b) the `.git` HEAD ref changes (branch
   switch/pull — the ref watcher exists; its error-listener gap is
   `harden-runtime-event-resilience`'s scope, not ours). The post-commit hook remains as a
   fast path; it stops being the only path.
4. **`openlore doctor --fix`.** Executes exactly the remediations doctor already prints
   (re-analyze, `install --force` re-wire), one confirmation per destructive-ish action in
   TTY, `--yes` for automation. Bare `doctor` stays read-only.

## Impact

- Specs touched: `mcp-handlers` (read-path repair trigger + disclosure), `cli`
  (watcher/daemon rebuild trigger, doctor `--fix`).
- Likely code: `src/core/services/cold-start-bootstrap.ts`,
  `src/core/services/mcp-handlers/utils.ts`, `src/core/services/mcp-watcher.ts`,
  `src/cli/commands/doctor.ts`, `src/cli/commands/serve.ts`.
- Cross-references (do not duplicate): `harden-analyze-rebuild-atomicity` (every repair
  ride its atomic swap), `harden-vector-index-coherence` (vector-lane correctness),
  `add-ownership-tagged-conclusions` (finer-grained invalidation — composes, not competes),
  `add-incremental-early-cutoff` / `add-symbol-content-hashes` (cheaper change detection
  shrinks how often repair fires), `harden-runtime-event-resilience` (ref-watcher
  robustness), `unify-onboarding-entrypoint` (shares the auto-init guardrails).

## Non-goals

- No blocking repair anywhere: a read never waits for a rebuild.
- No new staleness *detector* — only wiring existing verdicts to an existing rebuild.
- No change to detection honesty: disclosure-during-repair strengthens, never replaces,
  the staleness verdict.
- No repair loops: a rebuild that completes and still yields a trigger discloses and stops
  (at-most-once latch), never thrashes.
