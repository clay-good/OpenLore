# Raise the Node floor to where `node:sqlite` actually exists — and probe the capability, not the version

> Status: IMPLEMENTED (2026-07-19). The floor moved from `>=22.5.0` to `>=22.13.0` (the verified
> unflagged `node:sqlite` line, nodejs/node#55854) across all three declarations — `engines.node`
> (package.json), `MIN_NODE` (node-version-guard.ts), and `MIN_NODE_MAJOR/MINOR_VERSION`
> (constants.ts) — plus the README badge/requirement line and the live docs (cli-reference,
> OPENSPEC-INTEGRATION). `checkNodeVersion` and doctor's Node check now probe `node:sqlite` via
> `process.getBuiltinModule` (injectable `isSqliteAvailable`) so the capability, not the version
> number, has the final word: a version at/above the floor with the builtin unavailable fails
> honestly (stderr line + exit code 78 / doctor `fail` naming the missing capability), never an
> uncaught first-import crash. The guard test extends the floor-coherence check to constants.ts and
> adds probe cases. Not touched: the historical `docs/specs/openlore-spec-26-*` audit record, whose
> since-reversed "keep 22.5" recommendation is left as dated history.
>
> Original problem (2026-07-03, e2e audit follow-up): `package.json` declared `engines.node:
> ">=22.5.0"`, but `node:sqlite` required `--experimental-sqlite` until Node 22.13.0 / 23.4.0 and
> nothing in the tree passes that flag — so a fresh install on the low end of the DECLARED range
> crashed at first import, while the version guard and doctor both blessed the very version that
> crashes.

## The gap

- **The declared floor is below the working floor.** `package.json` declares
  `engines.node: ">=22.5.0"` (`package.json:20-22`), but three modules statically
  `import { DatabaseSync } from 'node:sqlite'` at module load: `src/core/services/edge-store.ts:3`,
  `src/core/services/mcp-handlers/epistemic-lease.ts:35`, `src/cli/preflight/score.ts:22`.
  `node:sqlite` shipped behind `--experimental-sqlite` from 22.5.0 and was unflagged only in
  Node 22.13.0 / 23.4.0 (nodejs/node#55854, commit 55239a48b6 — the verified floor; re-confirming
  it against the release notes is an implementation task). No reference to `--experimental-sqlite`
  exists anywhere in `src/` or `scripts/`, and the bin entry cannot pass Node flags. On Node
  22.5–22.12 the CLI and MCP server crash with `ERR_UNKNOWN_BUILTIN_MODULE`-shaped failures at
  first import — inside the range we promise works.
- **The guards validate the number, not the capability.** `checkNodeVersion`
  (`src/cli/node-version-guard.ts:30`, `MIN_NODE = { major: 22, minor: 5 }` at `:19`) and doctor's
  `checkNodeVersion` (`src/cli/commands/doctor.ts:55-70`) do version arithmetic and even print
  "requires >=22.5 for node:sqlite" (`doctor.ts:62`) — asserting a capability neither ever probes.
  A user on 22.10 passes both checks, then crashes. That is the inverse of the honesty contract:
  the diagnostic tool certifies an environment the product cannot run in.
- **Three floor declarations, one truth.** `MIN_NODE` (`node-version-guard.ts:19`),
  `MIN_NODE_MAJOR_VERSION`/`MIN_NODE_MINOR_VERSION` (`src/constants.ts:273-274`), and
  `engines.node` must move together; README repeats the stale figure ("Node.js 22.5+",
  `README.md:481`).

## What changes

**The floor becomes the first version where `node:sqlite` is available unflagged; the guard stops
trusting version arithmetic and probes the module itself.**

- Raise `engines.node`, `MIN_NODE`, `MIN_NODE_MAJOR_VERSION`/`MIN_NODE_MINOR_VERSION`, doctor
  copy, and the README requirement line to the verified floor (22.13.0, re-confirmed from the
  Node release notes at implementation time). The existing sync test between `MIN_NODE` and
  `engines.node` (`node-version-guard.test.ts`) extends to cover `constants.ts`.
- **Capability probe > version arithmetic.** `assertSupportedNode` and doctor's Node check gain a
  direct availability probe — `process.getBuiltinModule('node:sqlite')` (itself 22.3+, safely
  inside the new floor) — so the verdict is "node:sqlite is loadable", not "the version number is
  big enough". A version that passes arithmetic but fails the probe (a distro build, a future
  re-flagging) fails honestly with the same one-line stderr message and exit code 78, never a
  stack trace from the first `EdgeStore.open()`.
- Doctor's fail copy names the real requirement ("node:sqlite unavailable on this Node") and keeps
  the existing fix line. No new constants beyond the corrected floor values.

## Why this is in scope

A wrong `engines` floor is the first-run experience failing on a supported-by-declaration
environment — the exact class the zero-interaction-onboarding work exists to prevent. The fix is
deterministic, local, and shrinks a claim to what is provable: the guard asserts the capability it
actually depends on, which is the substrate's own verify-don't-guess rule applied to its own
runtime.

## Impact

- Files: `package.json` (`engines`), `src/cli/node-version-guard.ts` (+ test),
  `src/constants.ts:273-274`, `src/cli/commands/doctor.ts:55-70,461`, `README.md:481`.
- Specs: `cli` — 1 ADDED requirement (NodeFloorMatchesSqliteCapability).
- Tool surface: unchanged (no MCP change; guard/doctor behavior only).
- Risk: low. Users on 22.5–22.12 move from a crash to a legible "upgrade Node" message; everyone
  at or above the true floor sees no change. The npm `engines` warning tightens to the truth.
