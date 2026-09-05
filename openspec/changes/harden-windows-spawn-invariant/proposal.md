## Why

`extend-api-for-supervising-hosts` (#431) fixed the Windows console-flash and zombie-daemon
regressions and left two structural guards behind so the bug class could not return. Reviewing the
merged result against the whole tree found that the guards do not yet cover the class they claim,
and that three `git` spawns were never migrated.

**The bug class.** `windowsHide` defaults to false in Node. A console program spawned from a parent
with no console of its own — the `serve`/`mcp` daemon, a Claude Code hook (`orient --inject`, which
fires on every user turn once installed), the Pi extension host — opens a brand new visible console
window, one per spawn. That is what made the app unusable on Windows.

**What the guards miss.**

- `git-exec.test.ts` matched only the `execFile` / `execFileSync` / `execFileAsync` shapes, so a
  `spawn`/`spawnSync` of `git` was invisible to it. Three such sites survived the migration, two of
  them inside MCP handlers on the daemon path the fix was written for:
  `epistemic-lease.ts` (`git rev-parse HEAD`, on the tool-invocation path), `analysis.ts`
  (`runGit`), and `git-diff.ts` (`git cat-file --batch`).
- That same guard skipped any FILE that imported `git-exec.js`. All 30 migrated files import it, so
  the guard exempted precisely the files most likely to grow the next `git` spawn.
- `windows-detached-spawn-guard.test.ts` fires only on `detached: true`. The flash needs no
  `detached` at all — none of the three sites above is detached.

Six further non-`git` spawns had the same defect and no guard that could see them, four of them
reachable from the daemon or the Pi host (`which gryph`, the synchronous `gryph query`, the Pi
extension's POSIX spawn branch, plus `claude` and `docker` probes).

## What Changes

All additive or one-line. No behavioural change on macOS or Linux, where `windowsHide` is a
documented no-op.

**One invariant, stated directly.** A new `windows-hidden-spawn-guard.test.ts` replaces both
source-scanning guards with an import-aware scanner: EVERY subprocess spawned from `src/` sets
`windowsHide: true`, unless it inherits the parent's console (`stdio: 'inherit'`), which is the
interactive re-entry path — `heap-sizing`'s re-exec of the user's own command, `preflight`'s
re-analyze, `update`'s package-manager run — whose prompts must keep reaching a real console.

Import-awareness is what makes the scan usable: it resolves which local identifiers are bound to
`node:child_process`, so the hundreds of `regex.exec(...)` / `db.exec(...)` method calls are not
false positives, and an aliased import (`import { spawn as launch }`) is not a false negative. The
git-routing invariant moves into the same file, and stops exempting whole files: an alias of the
guarded helper is simply not a `node:child_process` binding, while a fresh raw import beside it is.

**The nine unguarded spawns are fixed**, three by routing through `git-exec.ts` (which gains
`spawnGit` / `spawnGitSync` for the streaming and fd-redirected shapes), six by setting the option
directly.

**Two correctness fixes found in the same review.**

- `execFileGitSync` typed a plain-options call as returning `string`, but Node's `execFileSync`
  returns a `Buffer` unless given an encoding — so the ergonomic `execFileGitSync('git', args,
  { cwd }).trim()` was a latent `TypeError` against a passing type check. It now defaults to
  `'utf-8'`; `{ encoding: 'buffer' }` still yields bytes.
- Both daemon exit paths used `then`, so a `teardown()` that rejects on one of its unguarded
  synchronous steps skipped `process.exit` entirely and surfaced as an unhandled rejection — the
  zombie daemon returning in exactly the failure case the fix exists to prevent, after the client
  was told the stop succeeded. Both now use `finally`.

## Deliberately NOT done

- **`stdio: 'inherit'` sites are not touched.** Forcing `CREATE_NO_WINDOW` on them would detach the
  user's own interactive command from the console it needs.
- **No new spec domain.** The invariant is recorded as one `cli` requirement, mirroring
  `analyzer: GitPathOutputFidelity`, which holds the identical "one shared helper plus an automated
  guard" shape for git's `core.quotepath`.
- **The `finally` change carries no dedicated regression test.** `teardown()`'s awaited steps are
  individually guarded (`drainServeRebuilds` uses `allSettled`, the watcher stop is `.catch`ed), so
  forcing a rejection would mean contriving a throw from a synchronous step. It is defensive
  hardening, not a reproduced failure, and is documented as such at the call site.
