# Structural Change Analysis (Graph Diff)

> Spec 21. Deterministic, offline, no API key. A structural **complement** to `git diff`.

`structural_diff` answers what a change did *structurally*, not textually. The difference between:

- **git diff** — "these 40 lines changed"
- **structural_diff** — "this removed function `gamma`, changed the signature of `alpha`, and 5 of
  `alpha`'s callers in other files are now **stale**"

The second is a *computed consequence* — Layer 3 — that a review or refactor agent would otherwise
re-derive by hand from a raw text diff.

Prior art is AST diffing (difftastic) — comparing syntax trees instead of lines. This goes one
level up and diffs the **graph** (the call relationships), which is where the consequences of a
change actually live.

## What it reports

Between two states (working tree vs a ref, or two refs):

- **added / removed functions** — by stable node id.
- **signature changes** — same function, changed signature (`before` → `after`).
- **stale callers** — for each signature-changed or removed function, the callers **in the
  canonical graph that are NOT part of this change** — i.e. callers that may now be broken because
  the callee moved under them.
- **rename/move candidates** — a removed function and an added function with the same signature
  shape (same file → high confidence, different file → medium). **Reported as both** the remove+add
  and a rename candidate — never silently guessed.
- **edge deltas** — calls added/removed among the changed files.

## Tool contract

```jsonc
// Working tree vs HEAD (the default)
{ "directory": "/abs/path" }
// vs another ref
{ "directory": "/abs/path", "baseRef": "main" }
// two committed refs
{ "directory": "/abs/path", "baseRef": "v1.0.0", "headRef": "v1.1.0" }
```

Output:

```jsonc
{
  "base": "abc1234", "head": "working tree",
  "changedFiles": [{ "path": "src/mod.ts", "status": "modified" }],
  "summary": { "addedFunctions": 1, "removedFunctions": 2, "signatureChanges": 1,
               "addedEdges": 3, "removedEdges": 1, "staleCallers": 5, "renameCandidates": 1 },
  "added":   [{ "name": "delta", "file": "src/mod.ts", "signature": "function delta(z: string): void" }],
  "removed": [{ "name": "gamma", "file": "src/mod.ts", "staleCallers": [] }],
  "signatureChanged": [
    { "name": "alpha", "file": "src/mod.ts",
      "before": "function alpha(a: string): number",
      "after":  "function alpha(a: string, b: number): number",
      "staleCallers": [{ "name": "consumer", "file": "src/other.ts" }] }
  ],
  "renameCandidates": [
    { "from": { "name": "oldName", "file": "src/mod.ts" }, "to": { "name": "newName", "file": "src/mod.ts" },
      "confidence": "high", "note": "…reported as both remove+add and this rename candidate — verify." }
  ],
  "edges": { "added": [...], "removed": [...] },
  "soundness": { "posture": "structural-complement-to-git-diff", "caveats": ["Rename/move detection is heuristic…", "…"] }
}
```

## Footprint escape detection (opt-in)

> Change `add-footprint-escape-detection` (PARALLEL-WORK-COORDINATION proposal 3). The back-side
> safety net for parallel agents: the swarm planner (`plan_parallel_work`) emits a *predicted*
> write-footprint per task; this confirms, after the code is written, whether the diff stayed inside
> it. Stateless and advisory — OpenLore detects the escape; the harness/CI/human enforces.

Pass a task's **declared write-footprint** (the `Footprint` `plan_parallel_work` produces) as
`declaredFootprint`, and optionally the declared footprints of other in-flight tasks as
`peerFootprints`. The result then carries an additional `escapeAnalysis` block. **With no
`declaredFootprint`, behavior is byte-identical to the above** — the extension is additive and dormant.

```jsonc
{
  "directory": "/abs/path",
  "declaredFootprint": {
    "taskId": "add-widget",
    "writeSet": [{ "id": "src/widget.ts::render", "filePath": "src/widget.ts", "writeMode": "modify" }],
    "readSet": ["src/util.ts::format"]          // symbols the task declared it would only read
  },
  "peerFootprints": [
    { "taskId": "refactor-dispatch",
      "writeSet": [{ "id": "src/dispatch.ts::dispatchTool", "filePath": "src/dispatch.ts", "writeMode": "append" }] }
  ]
}
```

`escapeAnalysis` output:

```jsonc
{
  "declaredTaskId": "add-widget",
  "summary": { "modifiedSymbols": 4, "escapes": 2, "outOfScopeWrites": 1, "readSetIntrusions": 1,
               "scopeCreep": 0, "newlyOpenedConflicts": 1, "registryResolutions": 0, "misDeclaredAppends": 0 },
  "escapes": [
    { "id": "src/dispatch.ts::dispatchTool", "classification": "out-of-scope-write", "editNature": "modifies-existing" },
    { "id": "src/util.ts::format",           "classification": "read-set-intrusion", "editNature": "modifies-existing" }
  ],
  "newlyOpenedConflicts": [
    { "symbol": "src/dispatch.ts::dispatchTool", "peerTaskId": "refactor-dispatch", "verdict": "WAW",
      "reason": "Out-of-scope edit modifies existing code in \"dispatchTool\", which is in peer \"refactor-dispatch\"'s declared write-set — a freshly-created write-write conflict." }
  ],
  "registryResolutions": [ /* { symbol, peerTaskId, reason } — a clean append into a peer's declared append */ ],
  "misDeclaredAppends":  [ /* { symbol } — declared `append`, but the diff modified existing code */ ],
  "findings": [ { "code": "footprint-escape-new-conflict", "enforcementClass": "advisory", "subject": "…", "message": "…" } ],
  "gated": false,
  "disclosure": "Escape detection is structural: … cannot catch a purely semantic conflict …"
}
```

**Escape classes** (a symbol the diff modified that lies outside the declared write-set):

- **out-of-scope-write** — modified a symbol in a file the task never declared.
- **read-set-intrusion** — modified a symbol that was declared *read-only*.
- **scope-creep-within-file** — added/modified a new symbol inside a *declared file* (lower severity).

**Conflict recomputation.** An escaped symbol that lands in a `peerFootprints` write-set is reported
as a **newly-opened** write-write conflict naming that peer (distinct from any overlap the plan
already knew about). For a registration hot-spot (`dispatchTool`, a registry array), a pure-addition
into a peer's declared `append` is downgraded to **resolved-by-merge**; a modify of an existing member
is a real WAW; a seed declared `append` that actually modified existing code is flagged as a
**mis-declared append**.

**Gating.** Each finding (`footprint-escape`, `footprint-escape-new-conflict`, `mis-declared-append`)
is **advisory by default**; a repo MAY opt one into blocking via `enforcement.policy`
(`{ "footprint-escape-new-conflict": "blocking" }`), and `gated` then reports whether any finding
resolved to blocking. `structural_diff` itself never blocks — enforcement and swarm re-planning are
the harness's job. Blocking findings are always retained in `findings` even past `maxResults`.

## How it works — bounded, never mutating

- **Two snapshots, one diff.** Only the **changed files** are re-parsed: old content from
  `git show <base>:<file>`, new content from the working tree (or `git show <headRef>:<file>`).
  Two in-memory graphs are built from just those files — cheap, and the canonical graph is never
  touched. Untracked new files are folded in (their functions are all additions).
- **Node/edge/signature diff** by stable id over the two snapshots.
- **Stale callers** come from the cached canonical graph (`getCallers`, the spec's
  `bfsFromDB(changedCallee, 'backward', 1)`), filtered to callers outside the changed set — the
  ones not updated alongside the callee.

## Honest limits

- **Rename/move is heuristic.** A renamed function looks like delete + add; the signature-shape
  match is a hint, not a fact. Both interpretations are always reported.
- **Cross-language signatures differ.** Signature-change detection is limited to what the analyzer
  extracts per language.
- **Edge deltas** cover calls among/out of the changed files; calls into unchanged files are used
  only for the stale-caller lookup.
- **Stale-caller analysis needs a current `analyze_codebase`.** Without the cached graph the diff
  still works, but stale callers are skipped and the response says so.
- **Escape detection is structural, not semantic.** It catches out-of-scope writes, read-set
  intrusions, and write-write conflicts an escape opens against a *declared* peer write-set. An
  escape that breaks a shared invariant with no shared write or call edge (a purely *semantic*
  conflict) can still slip through — the `disclosure` says so. A `resolved-by-merge` verdict confirms
  only *this* diff's edit; the peer's append is trusted from its declaration, so true non-overlap of
  two realized diffs needs the check run once per diff.

Implementation: [`structural-diff.ts`](../src/core/services/mcp-handlers/structural-diff.ts).
Tested over a real temporary git repo with a v1→v2 change (added/removed/signature-changed
functions, the stale-caller set, rename candidates, untracked files) in
[`structural-diff.test.ts`](../src/core/services/mcp-handlers/structural-diff.test.ts).
