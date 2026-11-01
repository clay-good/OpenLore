# Tasks

## 1. Detect and offer

- [x] 1.1 Add the "User-scope wiring" doctor check with a `rewire-user-scope` remediation. Verify with tests for none, repo-only, outdated and current.
- [x] 1.2 Offer the rewire after `openlore update` on a TTY only; `--yes` accepts it. Verify that a non-TTY run writes nothing.
- [x] 1.3 Add the wiring scope to `openlore status` (text and `--json`).
- [x] 1.4 Add a guard test: hook, MCP and serve entry points never write under `OPENLORE_HOME`.

## 2. Verification

- [x] 2.1 Dogfood on a temporary HOME seeded with roughlogic's June-era wiring. Show `doctor` output, then `doctor --fix --yes`, then a new worktree reaching OpenLore.
- [x] 2.2 Run `npm run test:unit`, lint and typecheck.
