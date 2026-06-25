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

## Notes / gotchas surfaced

- The carry-forward runs at **full analyze only** (the watcher path is a deferred follow-up). A rename
  made mid-watch-session carries at the next `openlore analyze`.
- `analyze --output <dir>` writes the graph to a custom dir; the snapshot + carry read the same
  `<dir>` (the `storeDir` param), while the memory/decision stores are always under `.openlore/`.
- Determinism: the continuity map is sorted by `from.nodeId`; re-runs on a fixed state pair are
  byte-identical (unit + integration tested).
