# Extract large composite literals in linear time, under a budget that actually holds

> One sentence: **three whole-tree walks re-read tree-sitter's `namedChildren` getter inside their
> own child loop, so one wide node cost O(k²) — and the per-file budget that should have abandoned
> the resulting 82 s file bounded the parse, not the extraction.**

## Why

A real-repo end-to-end run on `GoogleCloudPlatform/microservices-demo` (364 files) took **95 s**.
82 s of it was one 89 KB generated file:

```
[warn] slowest file(s) to extract: src/checkoutservice/genproto/demo.pb.go (81.7s), …
```

The cost is not size. grpc-go's *larger* `channelz.pb.go` is fine, because a newer
`protoc-gen-go` emits the descriptor as a string literal. Here it is emitted as
`var file_demo_proto_rawDesc = []byte{0x0a, …}` — one composite literal of ~4,400 elements. It is the
node's **width**, and a few thousand children is ordinary generated code, not hostile input.

Measured on a minimal one-file repository, `analyze --no-embed` end to end:

| elements | file size | before | after |
|---|---|---|---|
| 1,000 | 6 KB | 5.9 s | 4.7 s |
| 2,000 | 12 KB | 12.4 s | 5.0 s |
| 4,000 | 24 KB | 35.1 s | 5.4 s |
| 8,000 | 49 KB | 161.4 s | 5.4 s |

Net of ~5 s of fixed startup the work went 0.9 s → 7.4 s → 30 s → 156 s: N^2.5 or worse.

Two defects, both shipped:

1. **The super-linear walk.** `SyntaxNode.namedChildren` is a getter that re-marshals the node and
   allocates a fresh wrapper per child. `for (let i = node.namedChildren.length - 1; i >= 0; i--)
   stack.push(node.namedChildren[i])` evaluates it k+1 times, materializing k² children. Profiled:
   **18.4 s of 19 s** of self time in `get namedChildren`, entered from
   `httpAstWithinTraversalBudget`. Instrumented, the walks materialized 1,006,118 children for
   N=1,000 and 16,024,118 for N=4,000 — exactly N².
2. **A documented bound that did not hold.** `PER_FILE_PARSE_BUDGET_MS = 20_000` never fired on the
   82 s file, because it armed tree-sitter's deadline and the parse itself finished in
   milliseconds. The file was not abandoned and nothing in `parse-health.json` named it. A bound
   that does not hold is an honesty defect as much as a performance one.

## What changes

- A shared `readNamedChildren` boundary (`src/core/analyzer/ast-children.ts`) reads a node's
  children **exactly once** and reports how many it materialized. The three walks that re-read the
  getter per child use it: `httpAstWithinTraversalBudget`, and `rootAstIndex` /
  `astTraversalWithinBudget` in `exception-flow.ts` (the same shape, on the Python/Go error paths).
- The per-file budget becomes a **per-file extraction** budget: `PER_FILE_EXTRACTION_BUDGET_MS`, with
  the clock starting at `dispatchFileExtract` and checked at cooperative checkpoints — the parse
  (armed with the time *remaining*), each shared post-parse phase boundary, the shared tree-walk
  children boundary, and conclusively on return. A file that overruns is abandoned and disclosed as
  `budget-exceeded`, never `parse-failure`.
- The operator override keeps its name (`OPENLORE_PARSE_BUDGET_MS`): renaming it would silently
  ignore the setting of everyone already using it.

## What it does not change

No symbol and no edge. Pinned by a golden captured from the pre-fix build on the unmodified
`demo.pb.go` (167 functions, 193 edges, identical spans).

## Scope

`analyzer`. Nothing in the extraction pool, no new dependency, no behaviour behind a flag.
