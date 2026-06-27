# Dogfood — symbol identity continuity (2026-06-25)

End-to-end run through the real `openlore analyze` pipeline (built from `dist/`), proving the headline:
**a rename that used to orphan an anchored memory now carries it forward.**

## Setup

A throwaway git repo with one source file:

```ts
// src/tax.ts
export function computeTax(amount: number, locale: string): number {
  const rate = locale === 'US' ? 0.07 : 0.2;
  return amount * rate;
}
export function formatMoney(value: number): string { return `$${value.toFixed(2)}`; }
```

1. `openlore init` + `openlore analyze --no-embed` → 2 functions indexed.
2. `remember("computeTax applies a 7% US / 20% default rate…", anchor: {symbol: computeTax, file: src/tax.ts})`
   → recorded with 1 structural anchor; `recall` returns it **fresh**.

## The rename

`sed s/computeTax/calculateTax/` (a pure rename — the parameter shape is unchanged), commit, then
re-`analyze`:

```
  Memory continuity: carried 1 symbol(s) across rename/move (1 memory, 0 decisions re-anchored)
```

## Result

`recall` after the rename (was **orphaned** before this change):

```
summary: { fresh: 0, drifted: 1, orphaned: 0 }
memory freshness: drifted | verify: true
  anchor: symbol=calculateTax freshness=drifted
          carriedAcross={ from: { symbolName: "computeTax", filePath: "src/tax.ts" },
                          reason: "renamed", basis: "exact-signature",
                          atCommit: "bbb21dda…" }
```

`.openlore/memory/notes.json` ground truth — the anchor was re-pointed in place:

```json
{ "symbolName": "calculateTax",
  "nodeId": "src/tax.ts::calculateTax",
  "contentHash": "1ce0a65852ce…",   // ← OLD baseline preserved → drives the drifted verdict
  "carriedAcross": { "from": { "symbolName": "computeTax", "filePath": "src/tax.ts" },
                     "reason": "renamed", "basis": "exact-signature", "atCommit": "bbb21dda…" } }
```

A pure rename changes the declaration span (the name lives in it), so the honest verdict is
`drifted (carried)`, not `fresh` — exactly the spec's "fresh when the body is unchanged, drifted when it
changed." An `exact-body` move (byte-identical span) recalls `fresh (carried)`.

## Idempotency

A second `analyze` with no further rename logged **no** continuity line — the anchor now resolves to
`calculateTax` directly, so nothing disappeared and nothing was re-carried. The carry-forward is a clean
no-op when nothing moved.

## Adversarial e2e (PR #206 review — soundness)

Four scenarios run through the real `analyze` pipeline after the soundness fix. The first is the
regression that the review caught; the rest confirm the high bar holds without breaking real renames.

| Scenario | Setup | Expected | Result |
|----------|-------|----------|--------|
| **False positive (the bug)** | anchored `isAdmin` deleted; unrelated `checkFlag` (same param shape, **different** body) added | NO carry; `isAdmin` stays orphaned | ✅ no continuity line; `recall` → `orphaned`, no `carriedAcross` |
| **Legitimate rename** | `computeTax` → `calculateTax` (same body, new name) | carried, `drifted (carried)` | ✅ "carried 1 symbol(s)"; provenance present |
| **Rename + rewrite** | `parseConfig` → `loadConfig` with added trim/guard logic | NO carry (body changed beyond the name) | ✅ orphaned |
| **Clone elsewhere** | `ping` → `health`, but an identical-body `healthAlready` already exists in another file | NO carry (body not identifying) | ✅ orphaned |

Before the fix, the false-positive scenario **wrongly** re-anchored the security-critical `isAdmin`
memory onto `checkFlag` (matched on the shared `(u: { role: string })` shape). The fix — body identity
*modulo the symbol's own name*, plus name-independent-body uniqueness — rejects it while still carrying
the legitimate rename.

## Second-pass adversarial e2e (PR #206 review 2)

Run through the real `analyze` pipeline after the second hardening round.

| Scenario | Setup | Expected | Result |
|----------|-------|----------|--------|
| **Cross-language (Python)** | `compute_tax` → `calculate_tax` in a `.py` file | carried | ✅ "carried 1 symbol(s)"; recall `drifted`, basis `exact-signature` |
| **Ambiguous (real analyzer)** | `pick` split into two byte-identical clones `chooseA`/`chooseB` | no carry; both disclosed | ✅ orphaned + `possiblyMovedTo: [chooseA, chooseB]` |
| **Decision carry (disk test)** | decision anchored to `authorize` → renamed `checkAccess` | decision re-anchored | ✅ `decisionsUpdated=1`, `carriedAcross` provenance |
| **C2 false-carry (newcomer references old name)** | anchored `a()` deleted; unrelated `b()` that calls `a()` | no carry | ✅ stays orphaned (old-name-present guard) |
| **Unicode boundary** | `renameIdentifier("taxé + tax", tax→X)` | only the standalone `tax` replaced | ✅ `"taxé + X"` (was `"Xé + X"` before the fix) |
| **Recursive rename** | `fact`→`factorial` (self-call renamed too) | carried | ✅ matches modulo name |

### Performance

Measured `carryForwardContinuity` over this repo's real **2,638-node** graph:

- **delete-only / no-rename path:** ~**8.7 ms** (the full name-independent-body pass is gated off — no rename candidate).
- **rename path:** pays the one full normalized-body pass (~**850 ms** on 2.6k nodes) only on the analysis where an anchored symbol is actually renamed — the operation that is doing the useful carry. The common no-rename analyze and the move-only / delete-only paths never pay it.

## Notes / gotchas surfaced

- The carry-forward runs at **full analyze only** (the watcher path is a deferred follow-up). A rename
  made mid-watch-session carries at the next `openlore analyze`.
- `analyze --output <dir>` writes the graph to a custom dir; the snapshot + carry read the same
  `<dir>` (the `storeDir` param), while the memory/decision stores are always under `.openlore/`.
- Determinism: the continuity map is sorted by `from.nodeId`; re-runs on a fixed state pair are
  byte-identical (unit + integration tested).
