# Dogfood — footprint escape detection on this repo's real working tree

> Run 2026-06-24 against the un-committed working tree of this very change, using the
> built `dist/` handler (`handleStructuralDiff`). The point: prove the escape check
> fires on a *real* multi-file diff, not just synthetic fixtures.

## Setup

The change's working tree touches several files. We declared a deliberately *narrow*
footprint — claiming the task should only have written one symbol,
`footprint-escape.ts::analyzeEscape` — and supplied one peer task that claims it owns
`enforcement-policy.ts`. A faithful escape detector must then flag every other edit as
an escape and surface the collision with the peer.

```js
handleStructuralDiff({
  directory: <repo>,
  baseRef: 'HEAD',
  declaredFootprint: {
    taskId: 'escape-feature',
    writeSet: [{ id: 'src/core/services/mcp-handlers/footprint-escape.ts::analyzeEscape',
                 filePath: 'src/core/services/mcp-handlers/footprint-escape.ts', writeMode: 'modify' }],
  },
  peerFootprints: [{ taskId: 'enforcement-owner',
    writeSet: [{ id: 'src/core/services/mcp-handlers/enforcement-policy.ts::resolveEnforcementClass',
                 filePath: 'src/core/services/mcp-handlers/enforcement-policy.ts', writeMode: 'modify' }] }],
});
```

## Result (verbatim)

```
summary: {"modifiedSymbols":39,"escapes":38,"outOfScopeWrites":33,"readSetIntrusions":0,"scopeCreep":5,"newlyOpenedConflicts":1,"registryResolutions":0,"misDeclaredAppends":0}
escape classifications: ["out-of-scope-write","scope-creep-within-file"]
newlyOpenedConflicts: [{
  "symbol": "src/core/services/mcp-handlers/enforcement-policy.ts::resolveEnforcementClass",
  "peerTaskId": "enforcement-owner",
  "verdict": "WAW",
  "reason": "Out-of-scope edit modifies existing code in \"resolveEnforcementClass\", which is in peer \"enforcement-owner\"'s declared write-set — a freshly-created write-write conflict."
}]
gated: false | findings: all advisory (footprint-escape:advisory ...)
```

## What it confirms

- **Out-of-scope writes** (33): every edit to `enforcement-policy.ts`, `structural-diff.ts`,
  `tool-dispatch.ts`, `mcp.ts` — all `modifies-existing` — was correctly flagged as outside
  the one-symbol declared write-set.
- **Scope-creep-within-file** (5): the other new functions in the *declared file*
  `footprint-escape.ts` (e.g. `normalizeDeclaredFootprint`, `classifyEscape`) were classified
  as the softer scope-creep, not out-of-scope — because their file was declared. This is the
  body-comparison + file-membership logic working on `added` symbols.
- **Newly-opened conflict** (1): the edit to `resolveEnforcementClass` lands in the peer's
  declared write-set and modified existing code → a fresh WAW naming `enforcement-owner`, with a
  human-readable reason. Exactly the soundness signal proposal 3 exists to produce.
- **Advisory by default**: `gated: false`, every finding `advisory` — the repo declared no
  `enforcement.policy`, so nothing blocks. Enforcement stays the harness's job.

A second identical invocation produced a byte-identical `escapeAnalysis` (determinism), and a
call with **no** `declaredFootprint` produced no `escapeAnalysis` key at all and was otherwise
identical to the prior `structural_diff` output (the additive/dormant guarantee).
