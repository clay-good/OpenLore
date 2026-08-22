# map_in_flight_conflicts honesty: no silently dropped branches, no fake WAR from shared reads

> Status: BUILT (2026-08-22). The interference map promises "a change
> whose diff can't be fetched is a clearly-labeled 'not assessed' node — NEVER a false 'no
> conflict'" — and then its branch provider drops branches with three bare `catch { continue; }`.
> Separately, the hazard classifier labels pure read∩read overlap "WAR" with a false low-risk
> message, inflating the conflict count with non-conflicts.

## The defect(s)

1. **Branches silently vanish on git failure, violating the tool's own invariant.**
   `defaultEnumerateBranches` (`src/core/services/mcp-handlers/interference-map.ts:566-571`,
   verified verbatim) drops a branch entirely — no `notAssessed` node, no caveat — when any of
   three git calls fails: merge-base (`:566` `catch { continue; }`), rev-parse of the tip
   (`:568`), or the diff (`:571`). The module's own header (`:26-28`) and `DISCLOSURE` constant
   (`:80-81`) promise the opposite ("a change marked 'not assessed' was not evaluated and is
   never reported as conflict-free"), and the PR path honors it — `:607` pushes a
   `fetchError`-bearing node when `gh pr diff` fails. Shallow CI clones frequently cannot compute
   a merge-base, so in exactly the environment where a CI gate on `cross-actor-conflict` runs,
   every local branch can disappear and the gate passes with "no structural conflicts" while real
   WAW pairs exist. Related: `resolveRepoBase`'s final fallback (`:535-540`) returns the
   known-unverifiable `baseRef`, guaranteeing every subsequent merge-base fails → the whole
   repo's branches drop at once. Also undisclosed: `gh pr list … --limit 50` (`:592`) may
   truncate on a repo with more than 50 open PRs, and nothing says so.
2. **`classifyHazard` labels pure read∩read overlap "WAR" with a false message.**
   `src/core/services/mcp-handlers/change-footprint.ts:394-397`:
   `if (sharedFiles.length > 0 || sharedReads.length > 0) return { kind: 'WAR', witnesses }` —
   two tasks with fully disjoint write-sets that merely READ one common symbol get hazard WAR.
   Read-after-read is not a hazard in any taxonomy (nothing is written). The renderer compounds
   it: `interference-map.ts:424` says the pair "touch the same file(s) at disjoint symbols (…).
   Low risk." even when NO file is shared — only a read. Since footprint read-sets are forward
   closures (distance 6) of the write-sets, most branch pairs in one region share some mid-fan-in
   read → `conflictCount` inflates and the headline is dominated by non-conflicts.
3. **Folded minors (both verified).** (a) Two branches both ADDING the same new file are
   invisible to the hazard classifier: added files are skipped when building base symbols
   (`interference-map.ts:504` `if (f.status === 'added') continue`), so an add/add collision —
   a guaranteed merge conflict — surfaces at best as "not assessed / no-resolvable-symbols".
   `add-merge-tree-conflict-oracle` will catch this pair textually; its implementation should
   name this case as the motivating example (do not modify that change's files). (b)
   `GovernanceFinding.severity` is a free string and emitters disagree: `'warn'`
   (`footprint-escape.ts:313`, `:322`, `:331`) vs `'warning'` (`interference-map.ts:865`,
   `plan-parallel-work.ts:265`, `:294`) — an `enforcement.policy` or renderer that switches on
   severity treats identical intent differently.

## What changes

- **Branch failures become `notAssessed` nodes.** All three catch sites emit a node with reason
  `diff-unfetchable` and a detail naming the failed git operation and its error — the exact shape
  the PR path already produces. `resolveRepoBase`'s unverifiable-ref fallback is disclosed as a
  caveat (the map says which base it could not verify) instead of silently poisoning every
  merge-base. A `gh pr list` result that hits the 50-PR limit adds a truncation caveat.
- **Read-only overlap stops masquerading as WAR.** `classifyHazard` returns `WAR` only when the
  two write-sets touch the same FILE at disjoint symbols; pure read∩read overlap either becomes
  its own lowest-tier advisory kind (`shared-read`, with an honest "both read X; no write
  conflict" message) or is dropped from the conflict list — decided in implementation by whether
  the signal has any consumer value; the spec requires only that it never counts as a conflict
  or renders the same-file message.
- **Severity vocabulary normalized.** `GovernanceFinding.severity` becomes a closed union in
  `enforcement-policy.ts`; the three `'warn'` emitters move to the canonical spelling and the
  compiler holds the line thereafter.

## Why this is in scope

Honest boundaries are the doctrine (decision `c6d1ad07`): a tool whose header promises
"NEVER a false 'no conflict'" and whose default provider produces exactly that is a broken
contract, not a missing feature. Both fixes are deterministic and local — no new capability, no
new constant; hazard classes stay the existing closed set plus, at most, one honest advisory tier.
Blocking stays opt-in: the change makes the `cross-actor-conflict` findings a CI gate acts on
truthful, it does not add gating.

## Impact

- Files: `src/core/services/mcp-handlers/interference-map.ts` (branch-provider disclosure,
  base-ref caveat, PR-list truncation caveat, renderer message),
  `src/core/services/mcp-handlers/change-footprint.ts` (classifier split),
  `src/core/services/mcp-handlers/enforcement-policy.ts` (severity union) + the three `'warn'`
  emitter lines in `footprint-escape.ts`; tests alongside.
- Specs: `mcp-handlers` — 2 ADDED requirements (InFlightAssessmentFailuresAreDisclosed,
  ReadOnlyOverlapIsNotAConflict).
- Tool surface: unchanged (no new tool; `plan_parallel_work` shares the corrected classifier —
  its WAR consumers see strictly fewer, truer verdicts).
- Risk: low-medium. Downstream consumers keying on `kind: 'WAR'` see fewer results (intended);
  the severity union is a type-level change with two spellings to migrate.
