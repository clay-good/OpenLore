# Windows support

What is verified on Windows, what is not, and where the gaps are tracked. Written to close
[#434](https://github.com/clay-good/OpenLore/issues/434).

## What CI verifies

| Job | Covers |
|---|---|
| **Windows Unit Tests** | The whole unit suite on `windows-latest` — currently ~427 of 481 files passing, the rest on a tracked deny-list |
| **Windows Smoke** | The packed CLI end to end: install, analyze, the stdio MCP transport, daemon spawn and reuse, Pi's daemon path, and `serve --stop` asserted against the **OS process** rather than the client's claim of success |

Both are required. Before this, exactly one test file ran on Windows, so every path, filesystem and
subprocess suite — the places a Windows-only defect actually lives — went unexercised on the
platform.

### The deny-list, enforced both ways

Nothing is filtered out of the run. The whole suite executes, and
`scripts/windows-unit-report.mjs` judges the single resulting report against
`.github/windows-unit-exclusions.json`:

- a failing file that is **not** on the list is a new Windows regression → the job fails;
- a listed file with **zero** failures has been fixed → the job fails, so the entry gets deleted.

The first rule makes the job a real gate; without it the deny-list would be the only thing under
test. The second keeps the list a shrinking backlog rather than a permanent hole.

Judging one run matters. An earlier version excluded the listed files and re-ran them separately,
and the two runs disagreed immediately: one file passed alone and failed in the full suite. A test's
outcome can depend on what runs beside it, so two contexts can each be right and still contradict
each other. One run, one verdict.

It is a deny-list on purpose: a new test file runs on Windows unless someone deliberately names it.
An allow-list would leave every future file uncovered by default, which is how the original gap
happened.

The job runs with `--retry=2`. A Windows runner is slower, and a few fixture-heavy suites sit near
the 30s timeout there; retries absorb that without weakening the gate, since a deterministic failure
still fails all three attempts. The Linux job runs with no retries.

Most entries are test-side POSIX assumptions — a fixture rooted at `/test/project`, an expectation
spelled with `/`, a `#!/bin/sh` shim, an exec bit. A handful are marked `suspectedProductionBug`:
their failure shows a platform separator inside a value the product *persists or serves* — a bundle,
a spec reference, a generated path — which is a portability question about the artifact, not a test
bug.

The whole backlog, grouped by root cause, is [issue #452](https://github.com/clay-good/OpenLore/issues/452).

## Known issue: a libuv assertion during MCP session spawn

```
Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c, line 94
```

Reported reproducibly (2/2 runs) on Node v26.4.0 when an `openlore mcp --daemon` child's stderr is
**inherited from a shared interactive console**. In every observed case the process still exited 0,
the tool call succeeded, and the daemon stayed healthy.

**Assessment: an upstream Node/libuv message, not an OpenLore logic fault.** A minimal repro that
pipes stdio does not reproduce it, and the assertion names libuv's own async-handle bookkeeping
during fast process spawn and exit.

**CI cannot confirm or refute this, by construction.** A GitHub runner has no interactive console,
so a child there inherits a pipe — precisely the condition under which the reporter found it does
*not* fire. The assertion has never appeared in a Windows CI log, and that absence is therefore not
evidence. Treat it as open and cosmetic: if you see it, the run is still valid. Report it with the
output of the diagnostic below if it ever coincides with a real failure.

## Verification breadth

CI is a clean `windows-latest` image: no IDE, no endpoint-protection agent, no Job Object with
`KILL_ON_JOB_CLOSE`, one Windows version. It cannot speak for a machine whose process tree is
supervised.

`scripts/diagnose-windows-daemon.ps1` exists for that case. It reads Job Object membership and limit
flags (`IsProcessInJob`, `QueryInformationJobObject`), then re-runs the daemon-survival test through
the product's own path. Run it and attach the output to any Windows daemon report. It is not shipped
in the npm package.

One limit is structural rather than untested: libuv deliberately never sets
`CREATE_BREAKAWAY_FROM_JOB`, so a detached daemon cannot escape a parent Job Object. On a host that
sets `KILL_ON_JOB_CLOSE`, the daemon will still die with its launcher.

## The console-window class

`windowsHide` defaults to false in Node, so a console program spawned from a parent that has no
console of its own — the `serve`/`mcp` daemon, an agent hook, an extension host — opens a visible
console window per spawn. This is invisible to a headless runner: no behavioural test on any runner
can fail when the option is dropped.

It is therefore enforced by reading the source, in `src/utils/windows-hidden-spawn-guard.test.ts`:
every subprocess in `src/` sets `windowsHide: true` unless it inherits the parent's console, and
every `git` spawn routes through `src/utils/git-exec.ts`. See the `cli` spec requirement
`SubprocessesNeverSurfaceAConsoleWindow`.
