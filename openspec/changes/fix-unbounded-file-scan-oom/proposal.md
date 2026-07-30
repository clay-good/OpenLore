# A repository-wide scan must not hold the whole repository in memory

> Status: **BUILT** (2026-07-30). Full suite green (6,511 passed / 336 files), lint, typecheck,
> build. Reported as issue #302: `openlore install` dies with
> `FATAL ERROR: Ineffective mark-compacts near heap limit — JavaScript heap out of memory` during
> the enrichment-extraction phase. Reproduced, fixed, and verified against an `origin/main` build.
> Deterministic, no LLM, no new dependency.

## The gap

Every enrichment extractor fanned out over the repository like this:

```ts
await Promise.all(filePaths.map(async fp => {
  const source = await readFile(fp, 'utf-8');   // one read per file, ALL issued at once
  …
}))
```

`Promise.all` issues every read simultaneously, so at the peak the entire repository is resident in
the heap. `analyze` then ran **five** such scans concurrently (components, schemas, routes,
middleware, env vars), multiplying that peak by five. Nothing bounded how many files were in
flight, and nothing bounded how large a single file could be.

Past a few hundred megabytes of source this is a fatal OOM, not a slowdown. V8 aborts inside the
read-completion path — the user gets a C++ stack trace, no partial artifacts, no indication of
which phase died, and no remedy. The reporter's stack ends in `v8::String::NewFromOneByte`: a
`readFile` materializing a string.

Two independent failure axes, either of which is sufficient on its own:

| Axis | Trigger | Why concurrency alone doesn't fix it |
|---|---|---|
| Fan-out | Many ordinary files | Peak scales with file COUNT |
| Per-file size | One generated/minified blob | A single read exhausts the heap at any width |

**Measured on a 300-file / 439 MB repository, Node's default heap:**

| Build | Phase 3 result |
|---|---|
| `origin/main` | **FATAL ERROR — heap out of memory** (reproduced 3/3) |
| This change | completes; peak 635 MB, and still completes under a **512 MB** heap |

**Measured on a 6,000-file / 234 MB repository (peak RSS, same work):**

| Build | Peak RSS |
|---|---|
| `origin/main` | 3,112 MB |
| This change | **437 MB** (417 MB under a 384 MB heap) |

The peak stopped being a function of the repository and became a function of the bound.

## What changes

One module, `bounded-file-scan.ts`, is now the only way this codebase fans a read across a
repository. It carries the two bounds the failure needs, plus the ordering guarantee the artifacts
already depended on:

- **`mapFilesBounded`** — at most `SOURCE_SCAN_CONCURRENCY` (8) callbacks in flight, results
  returned in **input order** exactly like `Promise.all`. Input ordering is load-bearing: several
  scans document that their artifacts must be byte-identical across runs of a fixed repository
  state, and under a concurrency limit completion order additionally depends on which worker frees
  a slot first.
- **`readSourceCapped`** — `stat` before read, so a file above `SOURCE_SCAN_MAX_FILE_BYTES` (4 MB)
  is never materialized. Measuring after reading would already have allocated what the cap exists
  to prevent.

`analyze` runs the five extractors **sequentially** rather than as one `Promise.all`. Each is
internally bounded, but running five together multiplies that bound by five. This costs no extra
I/O — all five always read the same files.

An oversized file is **disclosed**, never silently dropped: `analyze` reports the count and the
worst offenders and marks the affected inventories a LOWER BOUND, using the sizes the walker
already recorded and the same predicate the scan applies.

The env-var scan additionally decides whether a file can contribute **before** reading it. It used
to decode every file in the repository — images, archives, model weights — only to discard it one
line later on an extension test.

## Deliberately NOT in this change

The call-graph build (`analyze` phase 4) has its own ceiling on very large repositories, and it is
NOT the same defect. Measured on a 4,000-file / 203 MB repository (32,001 functions), peak was
**2,323 MB**, composed of:

| Term | Retained |
|---|---|
| File content held for Pass 2 (type inference, import resolution, class hierarchy) | 196 MB |
| Serialized nodes + edges | 18 MB |
| **Intra-procedural CFG / def-use overlay** | **1,594 MB** |

The overlay dominates by an order of magnitude: it is built unconditionally for every function in
every supported language (~50 KB live per function), accumulated for the WHOLE repository, written
to SQLite, and then discarded. It is transient by design and never needs to be fully resident.

Bounding it is a distinct change with its own risk: the store is opened and `clearAll()`-ed only
after the build completes — deliberately, so a failed build cannot leave a wiped index
(change: harden-index-store-lifecycle) — so the overlay cannot simply be streamed into the store as
it is produced. It needs either a spill-to-disk hand-off or a gate, and it touches the artifact the
whole product reads. This change fixes the reported crash and the unbounded-scan shape that caused
it; the overlay belongs in its own change.

## Why it stays fixed

The bug was not one bad line — it was a SHAPE, written independently in eight places, and it is
the natural way to write a repository scan. So the guards are structural as well as behavioural:
`bounded-computation.test.ts` fails the build if a scan module reintroduces a raw `readFile` or an
unbounded `Promise.all(x.map(…))`, if `analyze` puts the five extractors back on one `Promise.all`,
if the disclosure is dropped, or if either bound is widened past the point of being a bound. Every
guard was mutation-tested: each was confirmed to FAIL when the defect is reintroduced.
