# Tasks — fix-node-sqlite-engine-floor

## Implementation
- [x] Re-confirm the verified floor from the Node release notes (nodejs/node#55854 unflagged
      `node:sqlite` in 22.13.0 / 23.4.0) and raise `engines.node` in package.json to it
- [x] Align every floor declaration: `MIN_NODE` (node-version-guard.ts:19),
      `MIN_NODE_MAJOR_VERSION`/`MIN_NODE_MINOR_VERSION` (constants.ts:273-274), doctor copy
      (doctor.ts:62,461,68 nvm hint), README requirement line (README.md:481)
- [x] Capability probe in `assertSupportedNode` (node-version-guard.ts:44-50): after the version
      check, verify `process.getBuiltinModule('node:sqlite')` returns the module; on failure emit
      the same one-line stderr message + exit code 78 (EXIT_UNSUPPORTED_NODE), never a stack trace
- [x] Same probe in doctor's `checkNodeVersion` (doctor.ts:55-70): a passing version number with a
      failing probe is `fail` with "node:sqlite unavailable on this Node", not `ok`

## Verification
- [x] Extend the MIN_NODE ↔ `engines.node` sync test (node-version-guard.test.ts) to also assert
      constants.ts's pair matches — one floor, three declarations, test-pinned
- [x] Unit test: probe failure (mock `getBuiltinModule` returning undefined) → `ok: false` with
      the capability message, exit code 78 through `assertSupportedNode`
- [x] Unit test: version arithmetic passes but probe fails → guard still fails (capability wins
      over arithmetic); version below floor still fails with the version message
- [x] Manual/CI smoke: `node -e "require('node:sqlite')"`-equivalent probe green on the CI Node;
      full suite green
- [x] Grep-check: no remaining `22.5` floor claim in src/, README, or docs after the bump

## Spec
- [x] `cli` delta: ADD NodeFloorMatchesSqliteCapability
