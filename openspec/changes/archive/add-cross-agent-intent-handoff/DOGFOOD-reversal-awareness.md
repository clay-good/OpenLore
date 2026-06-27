# Dogfood — ReversalAwareness (PR #168)

End-to-end run of the merged build against a **real git repo** with real commits and real memory
supersession, exercising the path the unit tests cannot (the reverting-commit SHA in the warning).

## Setup
1. Fresh repo `df-reversal` with `src/pay.ts` (`processPayment` → `chargeCard`); `git init` + commit **C1**.
2. `openlore init` + `openlore analyze` (BM25 index, so `orient`'s search resolves `processPayment`).
3. `remember` M at C1: *"processPayment caches the card token in a module global to skip re-charging."*
4. Edit the file to remove the cache; commit **C2** (`b3dfd75…`) — the revert.
5. `remember` N at C2 with `supersedes: M.id` → M is retired with `invalidatedByCommit = C2`.
6. `orient { task: "work on processPayment" }`.

## Result — `orient.reversals` (verbatim)
```json
[
  {
    "source": "memory",
    "id": "3b20d084",
    "what": "processPayment caches the card token in a module global to skip re-charging",
    "reason": "processPayment must stay pure; the global token cache caused double-charges",
    "revertedAtCommit": "b3dfd75ebb982c4a64c3001d0a9114046333b731",
    "revertedAt": "2026-06-19T20:29:37.462Z",
    "supersededBy": "a6e77ea6",
    "warning": "Do not re-attempt: processPayment caches the card token in a module global to skip re-charging (retired as of commit b3dfd75e) — recorded reason: processPayment must stay pure; the global token cache caused double-charges"
  }
]
```

## Verdict — PASS
- `revertedAtCommit` is the **real SHA of C2** (`git rev-parse HEAD` after the revert = `b3dfd75…`), not a
  fabricated value. Semantically it is `invalidatedByCommit` = HEAD when the superseding memory was
  recorded — the commit the note was retired *as of*. In this disciplined flow (commit the revert as C2,
  then supersede) that equals the reverting commit; the field does not, in general, verify that a specific
  commit reverted the code.
- `reason` is the superseding memory's content (deterministic, no LLM).
- The reverted memory appears **only** under `reversals` — never re-served as authoritative context.
- Matches the spec scenario "A reverted approach is surfaced as do-not-repeat."

Unit coverage (decision-side reversal, scope exclusion, omitted-when-empty, never-authoritative) lives in
`src/core/services/mcp-handlers/orient-reversal-awareness.test.ts`. Full suite green: 4081 passed, 0 failed.
