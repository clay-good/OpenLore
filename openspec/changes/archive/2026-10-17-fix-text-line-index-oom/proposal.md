# The text-line index must not hold the whole repository in memory

> Status: **BUILT** (2026-07-30). Found by testing whether issue #304 (the CFG/def-use overlay)
> was the real ceiling on a large repository. It was not — this is. Deterministic, no LLM, no new
> dependency.

## The gap

`openlore install` on microsoft/TypeScript (80,113 files, 652 MB) at a 2 GB heap dies **after**
the call graph and the keyword index have both completed successfully:

```
✓ Function index built [keyword] (152046 functions)

<--- Last few GCs --->
FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory
```

The next step is the text-line index, and it materializes the entire repository twice over:

```ts
// analyze.ts — reads are POOLED (change: fix-unbounded-file-scan-oom) but the result is not:
// one array holding every file's text
const perFile = await mapFilesBounded(candidates.map(f => f.absolutePath), …);
const files = perFile.filter(f => f !== null);

// text-line-index.ts — then ONE RECORD OBJECT PER SOURCE LINE, for the whole corpus,
// before anything is written
const records: TextLineRecord[] = [];
for (const f of files) for (const l of extractLines(f.filePath, f.content)) records.push(l);
await db.createTable(TABLE_NAME, records, { mode: 'overwrite' });
```

Note what this is NOT: the fan-out here was already bounded by the fix for issue #302. **Bounding
concurrency does not bound retention.** A pooled read that collects every result into one array
still holds the whole repository, and this path then amplifies it — millions of small record
objects on top of the bytes they came from. That amplification is why this phase, and not the
call-graph build, is where a large repository actually runs out of heap.

## What changes

Both halves become streams, and nothing else about the index changes.

- **`analyze` yields files in bounded chunks** instead of reading them all up front. At most 32
  reads are in flight, and each chunk's text becomes collectable as soon as its lines are
  extracted. Chunks are consumed in walk order and each resolves in input order, so indexed row
  order is unchanged.
- **`TextLineIndex.build` accepts an async iterable** (arrays still work — every existing caller
  and test passes one) and **flushes to the table every `BUILD_FLUSH_LINES` (200,000) records**.
  The first flush creates the table with `mode: 'overwrite'`; later flushes append. Peak residency
  becomes one batch instead of the corpus.

The empty case is preserved exactly: the table is created only on the first non-empty flush, so a
repository with nothing indexable still leaves no table behind, and an empty rebuild still drops a
previously built index rather than leaving it stale.

## Deliberately NOT in this change

**Issue #304 (the CFG/def-use overlay) is not the ceiling it was filed as, and this change does not
touch it.** That issue was opened on a measurement taken from a synthetic repository whose
functions were pathologically dense (~250 bytes of overlay per source line). Re-measured on real
code:

| Codebase | Functions | Total overlay JSON | Avg / function |
|---|---|---|---|
| OpenLore | 2,978 | 5.5 MB | 1.9 KB |
| microsoft/TypeScript | 65,971 | **34.2 MB** | **544 B** |

Def-use edges are linear in function length (~3n+1 measured), so there is no algorithmic blowup —
the overlay is simply proportional to total source, and real source is far less dense than the
fixture that produced the original number. It remains a genuine O(source) growth term worth
bounding eventually; it is not what exhausts the heap today. #304 is re-scoped with these numbers
rather than fixed here.

## Why it stays fixed

`text-line-index.test.ts` covers the multi-batch path directly, against a lowered flush threshold
(`_setBuildFlushLinesForTesting`) so a small fixture crosses it a dozen times — a fixture that
fits in one flush tests only the path that already worked. The tests assert that markers from the
FIRST, MIDDLE and LAST batches all survive, and every mutation was checked:

| Reintroduced defect | Caught by |
|---|---|
| Re-create the table per flush (later batches clobber earlier) | `zebracrossing missing — an earlier batch was lost` |
| Create the table for an empty corpus | the two empty-corpus cases |

The markers are deliberately single opaque words. A first draft used `alphaMarker` / `gammaMarker`,
which share the token `marker` under the identifier-aware BM25 tokenizer — so a search for one
matched the other and the clobbering mutation passed. That is recorded here because it is the kind
of vacuous assertion this suite is otherwise good at avoiding.
