# A stale memory names the commit that made it stale, and why

> Priority: P3 · Not built
> Reaches the agent through: `recall`, and the stale-memory lists of `orient` and `blast_radius`
> Why it helps the agent: it can read the one commit that broke a remembered fact and decide to re-anchor it or drop it.

## Problem

A memory records the commit where it became valid (`validFromCommit`, `src/types/index.ts`). The
end is recorded for one case only: supersession sets `invalidatedAt` and `invalidatedByCommit`.
Every other end has no evidence. A drifted or orphaned memory is a present-tense verdict from
`recall` ("orphaned now"). It cannot say which commit changed the anchor or what the change was.
The agent is told to distrust the memory and is given nothing to check.

## What changes

- Reuse the existing end fields and add one: `invalidation: { cause, commit, reason? }` on
  `AnchoredMemory`. `cause` is from a closed set: `anchor-content-changed`, `symbol-deleted`,
  `superseded-by <id>` (today's only writer).
- Find the commit with a bounded walk: the commits that touch the anchored file between
  `validFromCommit` and `HEAD`, oldest first; the first one where the anchor's content hash
  (`src/core/analyzer/symbol-content-hash.ts`, or the anchor's `span` text) no longer matches.
  The walk has a fixed commit cap.
- When the commit cannot be found (shallow clone, rewritten history, cap reached, no
  `validFromCommit`), the receipt says `commit: "unknown"` with the reason. Never a guessed SHA.
- `openlore analyze` and the watcher write the receipt once, when they first see the memory stale.
  `recall` serves it; if none is stored yet, `recall` computes it for the response and does not
  write. Example: "orphaned since `ab12cd34`: symbol deleted".
- `recall` with `asOf` reports the closed interval (valid from A, ended at C, cause).
- `staleTriggeredMemories` in `orient` and `blast_radius` carry the same receipt.

## What does not change

- No new tool. `recall` keeps its name, verdicts and lanes.
- Which memories are stale does not change. The receipt is evidence for the existing verdict.
- The cursor stays the commit, never wall-clock time. No model. Local git only.
- Old records without a receipt stay valid. Works without OpenSpec.

## Limits we disclose

- Memories only. Decisions keep their own supersession record.
- A memory refuted by a `verify_claim` claim (`evidenceRefuted`) gets no receipt in this change.
- A stored receipt is not rewritten. Two clones that saw different history can hold different
  receipts; each is correct for the history it saw.
- An uncommitted edit has no commit: the receipt says `commit: "unknown"`, reason "working tree".

## Depends on

Shipped: bitemporal memory fields, anchor verdicts (`src/core/decisions/anchor.ts`), per-symbol
content hashes, continuity carry-forward at analyze.
