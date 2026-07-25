# The first index is all-or-nothing: minutes of "no index found" before the first answer

> Status: PROPOSED (2026-07-23, competitive substrate sweep). On a repo of real size, the first
> `analyze` takes minutes — and until it finishes, every tool answers "no index found." Yet the
> pipeline already processes files in significance order (hubs and entry points first), so
> thirty seconds in, the most valuable fraction of the graph exists in memory and is worth
> serving. The field's convergent answer is serve-partial-while-indexing: answer from what
> exists, disclose completeness, finish in the background. OpenLore already has exactly this
> contract for STALE indexes (serve stale + "refresh started" disclosure); this change extends
> it to the ABSENT case — the first-run experience, which is also the onboarding experience.
> Composes with `optimize-incremental-and-coldstart-scale` (which moves the first build off the
> server's event loop; this change makes its output usable before completion).

## The gap

- **Absent ≠ stale in today's serving contract.** `cold-start-bootstrap.ts` serves reads from
  the STALE index with a disclosure while a rebuild runs (`:16-27`, `:154-165`), but when no
  index exists (`hasAnalysis`, `:79-81`) tools fall back to "run analyze" guidance
  (`index-absent`, `:50`) for the entire build.
- **The value ordering already exists and is wasted.** `RepositoryMapper` sorts all files by
  significance score descending (`repository-mapper.ts:780`, `:828`;
  `significance-scorer.ts:462`), so Pass 1 (`call-graph.ts:3979`) processes hubs and entry
  points first — and then nothing is visible until the final artifact write.
- **No mid-build flush exists.** Artifacts are written once at the end
  (`artifact-generator.ts`); there is no partial artifact, no completeness figure, no way for
  the epistemic lease to say "index 34% complete."
- The cost lands exactly at first contact: zero-interaction onboarding (PR #216) auto-starts
  the build, and the new user's first minutes with the product are its emptiest.

## What changes

1. **Periodic partial flush during an index-absent build.** During a first-run build, the
   pipeline flushes partial artifacts at phase boundaries and every N files (atomic writes via
   the existing `atomicWriteFile` + analysis-lock discipline), each stamped with a completeness
   receipt: `{filesExtracted, filesTotal, phase, partial: true}`. Because input is
   significance-ordered, the first flush already contains the hubs.
2. **The absent case adopts the stale case's serving contract.** Reads during an index-absent
   build serve from the newest partial artifact with a disclosed boundary through the epistemic
   lease: "index N% complete (significance-ordered: hubs and entry points first); unindexed
   files are invisible to this answer, not absent from the repo." Negative conclusions that
   partiality can invert — dead-code candidates, coverage gaps, "no callers" — are withheld or
   explicitly downgraded while `partial: true`; navigation and positive lookups serve normally.
3. **Completion erases partiality.** The final write is byte-identical to today's
   single-write output (the determinism oracle applies), clears the `partial` stamp, and the
   lease returns to its ordinary lifecycle. A partial artifact is never importable, exportable,
   attestable, or bundleable — it exists only for local serving during the build.
4. **CI stays single-shot.** The flush lane activates only for the interactive/daemon
   first-run path; `--embedded`/CI builds keep today's one-write behavior.

**Deliberately NOT borrowed** from the serve-while-indexing field: no query-time on-demand
parsing (answers come only from flushed facts — the deterministic artifact stays the single
source of truth), and no background prioritization scheduler beyond the significance order
that already exists.

## Why this is in scope

First impressions are the product's conversion funnel, and "structural answers within seconds
of install, honestly labeled" is the strongest first impression a substrate can make. The
change is a composition of shipped disciplines — significance ordering, atomic writes, the
stale-serving disclosure contract, the determinism oracle — extended to one uncovered state.

## Impact

- Files: `src/core/analyzer/artifact-generator.ts` (partial flush + completeness stamp),
  `src/cli/commands/analyze.ts` (flush cadence, interactive-path gating),
  `src/core/services/cold-start-bootstrap.ts` (absent-case serving + `repairStatusFor`
  extension), `src/core/services/mcp-handlers/epistemic-lease.ts` (partial-boundary note),
  negative-conclusion guards in `reachability.ts` / `coverage-gaps.ts`.
- Specs: `architecture` — 1 ADDED requirement (FirstRunServesPartialWithACompletenessReceipt).
- No new tool. Risk: medium — the hazard is a partial answer read as complete; mitigated by the
  `partial` stamp riding the lease into every response, the negative-conclusion withhold rule,
  and the never-export rule. Coordinate with `optimize-incremental-and-coldstart-scale`
  (child-process build emits the flushes; the server only reads).
