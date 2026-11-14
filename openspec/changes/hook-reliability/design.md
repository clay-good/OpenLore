# Design: hook reliability

Facts are from `main` at 0dd75dbef. Numbers marked "proposed" are confirmed or corrected by task 1.1.

## 1. Prompt submitted becomes a moment without a rename

**Decision.** Add `prompt-submitted` to the moment list. The wired command stays
`openlore orient --inject`, and its `MANAGED_HOOKS` entry (`claude-code.ts:299`) stays as it is: no
`moment` field, no `_openloreHook` marker. `runInject` (`orient.ts:66`) runs inside the same wrapper
as the other moments: off switch, time limit, once-per-session record, health record.
`openlore status` finds this moment by the plain `_openlore` group on `UserPromptSubmit`.

**Why.** A `moment` field would do two wrong things. The group would be skipped in user scope
(`claude-code.ts:847`), where it is wired today. And `isOurHookEntry` (`claude-code.ts:352-357`)
would stop matching the installed group, so an upgrade would add a second one.

**Rejected.** A new `openlore hook prompt-submitted` command wired in place of `orient --inject`: it
breaks installed entries and the plugin's `hooks.json`.

Off switches: `contextInjection.mode: "off"` (existing) or `hooks.prompt-submitted: false` (new key
in the strict `hooksRule`, `config-schema.ts:289`). Either one turns the moment off.

What the moment prints:

| State | Today | After |
|---|---|---|
| Thrown error, time limit passed, corrupt `.openlore/` | `error` pointer line on every prompt | nothing; counted as error or overrun |
| No index, build started or running | build note on every prompt | the same line, once per session |
| No index, no build possible | `no-graph` pointer on every prompt | the same line, once per session |
| Gate withheld (management intent, weak relevance, empty prompt) | pointer line | unchanged here |
| Strong match | orientation block | unchanged (a block is not a finding; never deduplicated) |

## 2. Budgets: one tested p95 target, one runtime limit

**Decision.** Each moment has two numbers. The p95 target is asserted by a test on a fixed fixture.
The runtime limit is the hard stop: past it the hook prints nothing and records an overrun.

| Moment | Harness timeout | Runtime limit today (`hook.ts:55`) | Proposed p95 target | Proposed runtime limit |
|---|---|---|---|---|
| prompt-submitted | not set by install (docs cite 30 s) | none | 1,000 ms | 3 s |
| before-edit | 15 s | 8 s | 800 ms | 3 s |
| after-tools, edit | 30 s | 15 s | 1,500 ms | 6 s |
| after-tools, shell command | 30 s | 15 s | 600 ms | 6 s |
| before-stop | 90 s | 50 s | 5,000 ms | 20 s |

Basis: CLI cold start is about 0.45 s; docs state about 300 ms of work for `orient --inject`. The
targets are whole-process times. Rule for task 1.1: a target is kept when the measured fixture p95
is at most the target. A runtime limit is lowered only when the measured p95 on this repository
(6,550 functions) is at most one third of the new limit; if not, today's limit stays. Any other
result goes to the owner before code changes.

**How the test avoids flakiness.** A generated fixture of fixed size (200 files, 2,000 functions,
one index build in `beforeAll`). The handler is timed in-process: 3 warm-up runs, then 30 runs,
assert p95 ≤ (target − 450 ms cold-start share) × multiplier. The multiplier is 1.5 locally and 3
when `CI` is set (`OPENLORE_LATENCY_MULTIPLIER` overrides). The test runs in the `test:budgets`
script, which has no file parallelism. One spawn test per moment runs the built CLI 5 times and
asserts the median against target × multiplier; on Windows it records and does not assert.

**Rejected.** Asserting on single spawn timings in the unit suite (noisy), and a benchmark script
with no assertion (nothing fails when a hook gets slow).

## 3. Finding identity and the seen-set

**Decision.** Identity = `sha256(code \0 subject \0 proofHash)`. `proofHash` is a hash of the
finding's proof with the line number left out: `location.path`, `discriminator`, and the
whitespace-normalized text of the cited source line. A fact with no source line (background change,
edit loop, peer notice, test-run fact) uses its existing discriminator (`changedAt`, return count,
run time). The first 8 hex characters are the finding id, printed after the finding as `[f:1a2b3c4d]`.

The seen-set stays in the per-session record `.openlore/session-ledger/hook-delivered/<id>.json`
(`hook.ts:222-262`). The record keeps `keys` (so an older CLI still reads it) and gains
`findings: { <identity>: { code, subject, shownAt, moment, audience, state } }`. The read and write
helpers move unchanged into `src/core/services/hook-session.ts` (new) so `orient.ts` can use them.

| Rule | Value |
|---|---|
| Shown at most | once per session to the agent, once per session to the user (the stop receipt) |
| Covers | all four moments, one identity for one finding at every moment |
| Reset | a new `session_id`; a changed proof (a new identity); a finding marked fixed that comes back |
| Not marked seen | a finding cut by the size budget (existing rule, `hook.ts:218`) |
| No `session_id` | no dedupe (existing rule, `hook.ts:235`) |

**Why.** Today `after-tools` keys a finding as `code:path:subject` (`hook.ts:411`) and `before-stop`
as `check:subject` (`hook.ts:504`). Two audiences are kept because the stop receipt goes to the user
(`hook.ts:682`); it must still list what the agent was told and did not fix.

**Rejected.** Line numbers in the identity: an edit above the finding would show it again.

## 4. Health data and acted-on counts

**Decision.** Each run that reaches the hook appends one line to
`.openlore/session-ledger/hook-runs.jsonl` (new): `{ t, moment, ms, outcome, shown }`, with
`outcome` one of `ok`, `error`, `overrun`. `ms` is the process uptime at exit. The file is cut to
its newest half at 1 MB. `openlore status` reads the last 7 days and computes p95 per moment.

Finding states, set by the hooks that already run the checks:

| State | Deterministic rule |
|---|---|
| `fixed` | shown; later the same check ran on the same subject, after a recorded agent edit to the subject's file, and did not report it |
| `decided` | shown; a decision recorded later contains the finding id in its title, rationale, or consequences (joined when `status` runs, not in a hook) |
| `open` | still reported by the last `before-stop` of the session |
| `not-assessed` | none of the above: the check did not run again |

**Why.** Append-only lines survive hooks that run in parallel; `agent-edits.jsonl` already works
this way. The 7-day window matches the existing cleanup of session records (`hook.ts:257`).

**Rejected.** `OPENLORE_TELEMETRY` (`telemetry.ts`): it is opt-in and off by default, and the health
line must work with no setup. A counter file rewritten on each run: parallel hooks lose updates.

## 5. A wired command that survives a missing runtime

**Decision.** `openlore install` writes the hook command with a guard:
`[ -f '<entry>' ] && [ -x '<node>' ] || exit 0; '<node>' '<entry>' hook <moment>`. For the `npx`
fallback form the guard is `command -v npx >/dev/null 2>&1 || exit 0`. Groups are still matched by
marker, so the next `openlore install` replaces an old unguarded command in place. Codex groups are
matched by the command's end (`codex.ts:30`), which the guard does not change.

**Why.** Today a moved or removed install makes every hook exit non-zero with `Cannot find module`.
The fix must live in the command string, because nothing of OpenLore runs in that case.

**Rejected.** `<command> || true` with stderr discarded: it also hides real diagnostics. A shim
script in `.openlore/`: it disappears when the user deletes `.openlore/`.

Upgrade and uninstall also remove any group whose `_openloreHook` value is not a current moment
(today such a group is never matched, `claude-code.ts:352-357`). `openlore doctor` checks hook
command launchers the way it checks the MCP launcher (`doctor.ts:767-780`).

## 6. What uninstall keeps

**Decision.** Uninstall keeps `.openlore/` and the skills copied by `openlore setup`, names both
with their paths, and prints the command to remove each. It does not delete them and does not ask.

**Why.** `.openlore/` holds decisions and memories; skills may have been edited. The summary already
names `.openlore/` (`install/index.ts:817-821`); copied skills are not named today.

**Rejected.** An interactive "remove data too?" prompt: uninstall also runs without a terminal.

## Spec placement

All deltas are in `cli`. `mcp-quality` "Real-World Reliability and Graceful Degradation" is about
tools, which must fail with a message. Hooks must fail with silence, so that requirement is not
changed.
