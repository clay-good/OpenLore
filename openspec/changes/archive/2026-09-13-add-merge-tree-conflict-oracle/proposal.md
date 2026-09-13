# A `git merge-tree` textual-conflict oracle inside map_in_flight_conflicts — separate "git will auto-merge" from "git will conflict"

> Status: PROPOSED (2026-07-03, e2e audit pass 4, enhancement). `map_in_flight_conflicts`
> predicts *symbol-level* hazards (WAW / shared-append / RAW / WAR) from the diffs of in-flight
> changes. It cannot today say whether git will actually conflict on the text: two branches that
> both modify `resolveCallSite` are flagged WAW even when their edits are in different parts of
> the function that git merges cleanly. Clash (clash.sh) proves the complementary cheap check —
> a read-only three-way merge simulation per branch pair — is deterministic, local, and
> git-native. Adding it as an evidence tier turns each hazard into "textual conflict (git will
> not auto-merge)" vs "semantic-only overlap (git auto-merges; the hazard is behavioral, not
> textual)" — the honest refinement the hazard classes lack. OpenLore's symbol-level typing
> stays the differentiator; this just adds the textual ground truth beside it.

## The gap

- `map_in_flight_conflicts` derives each footprint from the change's actual diff and classifies
  hazards per shared symbol, but every hazard is symbol-granular. A reviewer reading "WAW on
  `resolveCallSite`" can't tell whether they face a real merge conflict or a clean auto-merge
  with a behavioral question — two very different landing decisions.
- The information is one git command away. `git merge-tree` (the modern `--write-tree` form)
  performs a read-only three-way merge of two commits and reports conflicts without touching the
  work tree, index, or `HEAD` — exactly the stateless, advisory shape the tool already commits to.

## What changes

1. **A textual-conflict evidence tier.** For each in-flight pair the tool already compares, run
   `git merge-tree` between their tips (over the shared merge base) read-only. Annotate each
   symbol-level hazard with a textual verdict: `textual-conflict` (git reports a conflict
   touching the shared files), `clean-automerge` (git merges the text; the hazard is
   semantic/behavioral only), or `not-assessed` (a tip that can't be resolved — merge base
   missing, shallow clone, unfetchable PR — disclosed, never silently "clean").
2. **Keep it advisory and stateless.** No watcher, no stored merge results; the oracle runs at
   call time like the rest of the tool. The existing symbol-level hazard classes are unchanged —
   the textual verdict is an added field, so a consumer that only wants symbol hazards ignores it.
3. **Landing-order suggestion uses it.** When the tool suggests an order ("land #210 first"), a
   `textual-conflict` pair is a stronger signal than a `clean-automerge` one; the suggestion
   notes which.

## Why this is in scope

Coordination is an existing capability family; making its hazards honest about "will git actually
conflict" is a deterministic, local, no-LLM refinement of a tool OpenLore already ships. It costs
one git plumbing command per pair, reuses the diffs already fetched, and directly improves the
land-order advice agents and humans act on. Clash validated the pattern; OpenLore's contribution
is fusing it with symbol-level hazard typing, which Clash (file/hunk-level only) lacks.

## Impact

- Files: `src/core/services/mcp-handlers/interference-map.ts` (the `map_in_flight_conflicts`
  handler — add the merge-tree tier + verdict field), a small git plumbing helper (reuse the
  existing git shell-out utilities; honor `core.quotepath` per `fix-git-path-quoting`).
- Specs: `mcp-handlers` — 1 ADDED (InFlightConflictsCarryATextualMergeVerdict).
- No new tool (extends an existing one); the added field is bounded per conflict — measure
  against the payload-budget ceiling in `mcp-presets.test.ts`. Risk: low — `git merge-tree` is
  read-only and cannot mutate state; the `not-assessed` disclosure keeps an unresolvable pair
  honest. Verify: two branches editing disjoint parts of one function report
  `clean-automerge`; two editing the same lines report `textual-conflict`; an unfetchable tip
  reports `not-assessed`.
