# Analyze must not die of a native abort, and no single file may cost unbounded time

> Status: **BUILT** (2026-07-26). Found by an adversarial end-to-end pass against a 622-file hostile
> repository, then isolated to a 601-file minimal reproducer and **verified against an `origin/main`
> build** — both failures predate the security-hardening work in PR #292 and are not regressions
> from it. Deterministic, no LLM, no new dependency.

## The gap

Two failures, one shared root: the analyzer treats a single file's extraction as unbounded in both
time and blast radius, and the worker pool has no boundary that converts a native fault into a
reported one.

### 1. A worker fault kills the process with no JavaScript error

```
$ openlore analyze
… Generating analysis artifacts…
libc++abi: terminating due to uncaught exception of type Napi::Error
$ echo $?
134
```

Reproduced 3/3 deterministically. The user gets one line of C++ runtime noise: no stack, no
`[error]` line, no partial artifacts, no indication of which file caused it, and no remedy. For a
tool whose contract is that a quiet result means "nothing there" rather than "we broke", an
`abort()` is the worst available failure mode — it is indistinguishable from a crash in the host.

**Isolation (each run on a clean directory):**

| Input | Result |
|---|---|
| One 300 KB file of repeated `/*x` + 600 trivial `.ts` files | **abort, exit 134, ~163 s** |
| That 300 KB file alone | exit 0, **661 s** |
| The 600 files without it | exit 0, 14 s |
| The full hostile repo minus that file | exit 0, 424 s |

**Root cause, isolated during the build (this replaces the guess above).** The payload parses into a
right-leaning chain **100,002 nodes deep**, and `tallyParseHealth` — which runs precisely on trees
that carry errors — walked it recursively. It exhausts the stack, and the `RangeError` is raised
while executing inside `unmarshalNode` / `new SyntaxNode`, i.e. inside the native binding. A throw
raised in a native frame is not catchable as a JavaScript error; it becomes the C++ exception that
`libc++abi` aborts on. The extraction pool is implicated only because a worker's stack is where it
lands first — the same overflow is reachable on the main thread.

That makes the fix structural rather than probabilistic: the walk is iterative (depth stops being a
correctness cliff), and the parse is bounded in-band so a 100,000-deep tree is never built in the
first place.

### 2. One file can consume unbounded wall-clock, with no budget and no progress

| Payload (single 300 KB file) | Time |
|---|---|
| `/*x` repeated (unterminated block comment) | **661 s** |
| `import {` repeated | 156 s |
| `app.use(` repeated | 149 s |
| `<script ` repeated | 12 s |

Measured identically on `origin/main` and on PR #292's build (60 KB of `/*x` → 25 s on both), so
this is the tree-sitter parse and/or an extractor that is not one of the regex sites PR #292
bounded. `MAX_READ_SIZE` (`file-walker.ts`) caps how much is *read*; nothing caps how long one file
may be *worked on*. There is no per-file time budget, no progress line naming the file, and no way
to interrupt short of `Ctrl-C`.

This is not only a hostile-input problem: a minified bundle, a generated client, or a vendored
single-file library in an ordinary repository hits the same path.

### 3. Skips are reported as a bare count, and `doctor` contradicts them

`analyze` prints `Files skipped: 3` with no reason and writes no `parse-health.json`, while `doctor`
on the same repository reports `✓ Parse health  no files parsed with errors`. Two surfaces, two
answers, neither actionable — the same silent-under-extraction shape that
`add-parse-health-boundary-disclosure` closed for parse errors, still open for skips.

## What changes

**Contain the fault, bound the cost, and name what was dropped.**

- **A worker fault becomes a reported per-file failure, never a process abort.** The extraction pool
  installs boundaries for the failure modes that bypass a normal `catch` — `uncaughtException` /
  `unhandledRejection` inside the worker, non-zero `exit`, and `error` on the worker handle — and
  maps each to a structured per-file extraction failure. The build continues with that file recorded
  as failed. If the pool cannot continue at all, `analyze` exits non-zero with an `[error]` line
  naming the file and the remedy, never via `abort()`.
- **A per-file extraction budget, disclosed when it fires.** A file whose extraction exceeds a
  configurable wall-clock budget is abandoned and recorded as `budget-exceeded`, with its path and
  the elapsed time. The budget is generous by default (seconds, not milliseconds) so no ordinary
  file is affected, and is expressed as a named constant rather than a magic number.
- **Skips become a disclosed, structured record.** Every excluded file — size cap, encoding, parse
  failure, worker fault, budget — appears in the existing parse-health artifact with a reason, and
  `analyze`'s summary line names the reason breakdown instead of a bare count. `doctor` reads the
  same record, so the two surfaces cannot disagree.

**Explicitly out of scope:** making the 661 s parse itself fast. The cost lives in the grammar/
extractor layer and warrants its own investigation; this change makes it *bounded and disclosed*
rather than unbounded and silent. Fixing the underlying cost is a follow-up, and this change's
budget disclosure is what will make it measurable.
