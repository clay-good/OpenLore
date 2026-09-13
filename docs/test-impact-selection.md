# Deterministic Test Impact Selection

> Spec 19. The headline Layer-3 instrument. Deterministic, offline, no API key.

You changed `parseConfig()`. Which tests should you run? `select_tests` answers it by walking
the call graph **backward** from the change to every test that transitively reaches it — and
returns each test with the path that connects it to the change. It also always selects the test
files the change itself added or edited, and says why each test was selected.

This is **static, call-graph-based regression test selection (RTS)** — established CS (Ryder &
Tip change-impact analysis; RTS++), not novelty — but served to the *agent at edit time* rather
than to CI after the fact. The same algorithm, a different consumer.

Why it matters:

- **grep can't do it** — tests reach the code through indirect call paths, not text matches.
- **the model is slow and unreliable at it** — it would have to read the whole suite and guess.
- **a deterministic graph does it instantly** — backward reachability over edges already stored.
- **it saves real money** — agents running full suites or guessing wrong is a major time sink.

## Honest soundness — read this

Static call-graph RTS is an **approximation**, and the tool says so in every response:

- For direct/static dispatch it is a safe **over-approximation** — it may select a few extra
  tests (you run slightly more; harmless).
- Dynamic dispatch, reflection, dependency injection, and runtime wiring can cause
  **under-approximation** — a relevant test may be missed. This is the classic RTS hazard.

So `select_tests` is a **prioritizer** — "run these first, they're almost certainly the relevant
ones" — **not a guarantee and not a replacement for the full suite.** The response carries:

- `soundness.posture: "over-approximate"` and explicit `soundness.caveats`.
- `coverage.testDetection: "full" | "partial" | "none" | "not-applicable"` — when test detection is
  incomplete for the changed languages, it says so rather than returning a falsely-confident empty
  set. `not-applicable` means no production function changed (only test files did).

## Tool contract

```jsonc
// Input — one of changedSymbols / diffRef required
{ "directory": "/abs/path", "changedSymbols": ["parseConfig"], "maxDepth": 12 }
{ "directory": "/abs/path", "diffRef": "HEAD" }   // diff the working tree

// Output
{
  "changed": ["parseConfig"],
  "seeds": [{ "name": "parseConfig", "file": "src/config.ts" }],
  "selectedTests": [
    { "test": "config.test", "file": "src/config.test.ts",
      "viaPath": ["config.test", "loadConfig", "parseConfig"], "confidence": "medium",
      "reason": "included: reaches changed symbol at depth 2" }
  ],
  "soundness": { "posture": "over-approximate", "caveats": ["…dynamic dispatch may under-select…"] },
  "coverage": { "languages": ["TypeScript"], "testDetection": "full" },
  "flakiness": { "assessed": false, "reason": "No test-outcome history is read: …" }
}
```

`confidence`: `high` for a direct caller or a direct `tested_by` association on the changed
function; `medium` for a transitive reach; `low` for sibling-file fallback (newly-added /
untested functions). Tests are deduped across discovery paths, keeping the highest confidence and
shortest path.

## How it works

Pure reuse of edges and traversal OpenLore already has — **no schema change**:

- **Backward reachability** — a path-tracked BFS over [`buildAdjacency`](../src/core/services/mcp-handlers/graph.ts)'s
  backward map (`calls` **plus inheritance** edges, so overridden/parent methods widen selection —
  a safety win for dynamic dispatch). Seeds = the changed functions; hits = nodes with `isTest`.
- **`tested_by` harvest** — for any reached production node, its `tested_by` edges add tests whose
  association is import-based (the test imports but doesn't directly call), which the call-walk
  alone might miss.
- **Inputs** — a symbol set, or a git diff resolved through the drift subsystem's
  [`getChangedFiles`](../src/core/drift/git-diff.ts) (the same changed-file logic drift uses),
  mapped to function nodes.

Implementation: [`test-impact.ts`](../src/core/services/mcp-handlers/test-impact.ts). Tested over
a fixture with known test→code reachability (paths, over-approximation posture, sparse-coverage
honesty, seed resolution) in
[`test-impact.test.ts`](../src/core/services/mcp-handlers/test-impact.test.ts).

> Requires a current `analyze_codebase` that included test files — `tested_by` edges and `isTest`
> nodes come from analysis. If the cached graph predates test inclusion, `select_tests` reports
> `testDetection: "none"` rather than pretending no tests are needed.

> **Index integrity.** Backward-reachability completeness depends on the index landing intact. When the
> persisted index does not reconcile against its build-time attestation (`degraded` — materially smaller
> than the build committed; or `mismatched` — a different schema), the response carries that verdict in
> `confidenceBoundary.integrity` and is not marked `complete`, so a too-small selection over a half-built
> index is disclosed rather than trusted. Re-run `analyze_codebase` to rebuild.

## Always-select tiers and per-test receipts

Reachability alone can miss the test that matters most: the one you just edited or added. When
`select_tests` selects from a diff, it unions three deterministic, git-derived tiers (change:
`add-test-selection-safeguard-tiers`):

| Tier | Selected | `reason` |
|---|---|---|
| New test | a test file added since the base ref, or an **untracked**, non-ignored test file (which `git diff` never lists) | `included: new test` |
| Changed test | a test file modified since the base ref | `included: test file itself changed` |
| Reachability | a test that transitively reaches a changed symbol (the existing walk) | `included: reaches changed symbol at depth N` |
| Same-file fallback | a test of another function in a changed function's file, when nothing reaches that function | `included: tests a function in the same file as a changed symbol` |

Tiers only **add** selections, never remove one. A tier file must satisfy the analyzer's own
test-file rule (a fixture under `test/` is not a test), lie inside the analyzed directory (diff paths
are mapped out of the repository root), exist on disk, and match an indexed test file exactly (a
same-named test in another folder is not selected). A deleted test file is not selected, and a
renamed one is selected under its new path. A test file the analysis has not indexed yet is selected
whole (`test: "*"`). A diff that touches only test files now selects them, instead of reporting that no
production function changed. When untracked files cannot be listed, a caveat says a brand-new
untracked test may be missing. At most 200 untracked test files are selected; a caveat counts the
rest. An untracked path with control characters, or one not on disk under the analyzed directory, is
skipped. Untracked files come from the working tree, so a `diffRef` base does not exclude them, just
as it does not exclude unstaged edits.

Every selected test carries the `reason` behind the path it is served with (so `reason`, `viaPath`,
and `confidence` always agree; a tier reason always wins), and `alsoIncludedBecause` lists any other
reason that selected it, tier first, then shallowest depth. A selection whose reaching path crosses a synthesized (heuristically recovered)
edge carries `structuralBasis: { synthesizedEdges, synthesizedBy }`, built from the existing edge
provenance labels (a direct edge for the same pair wins). A synthesized `tested_by` association counts
as one such edge, and `directResolvedOnly` skips it. A directly-resolved selection carries none,
and the response-level `confidenceBoundary` is unchanged.

`flakiness: { assessed: false }` states that no test-outcome history is read, so no test is labeled
flaky. A reader that flags a test only when runs at identical tree-hash inputs disagreed is deferred:
no local source records per-test outcomes against a tree hash.
