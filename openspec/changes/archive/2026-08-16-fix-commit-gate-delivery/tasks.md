# Tasks — fix-commit-gate-delivery

## Implementation
- [x] Shared helper: resolve the effective hooks dir via `git rev-parse --git-path hooks`
      (execFile array-args; falls back to `.git/hooks` when git is unavailable) in one
      dependency-light module both installers import
- [x] `installEnforcementHook` (enforce.ts:71-98) and `uninstallEnforcementHook` use the effective
      dir; success message names the RESOLVED path, not the literal `.git/hooks/pre-commit`
- [x] Decisions gate `installPreCommitHook` + post-commit hook (decisions.ts:202-240 and the
      post-commit block below it) use the same helper; marker stacking
      (enforce.ts:88-91, decisions.ts:229-234) unchanged
- [x] Hook-manager handling: hooksPath inside `.husky` → append the marker block to the manager's
      pre-commit script; unrecognized manager → actionable warning (manager, effective dir,
      wiring line) and NO success line
- [x] `openlore doctor`: check the openlore hook block exists IN the effective hooks dir and is
      executable; report "installed but unreachable" when a stale `.git/hooks/pre-commit` is
      shadowed by core.hooksPath
- [x] `enforce --json` envelope (enforce.ts:274-282) gains `schemaVersion: 1`; same for the
      `review --format json` envelope (review.ts — verified it has none today)

## Verification
- [x] Test: repo with `core.hooksPath` set → hook lands in the configured dir; a commit actually
      runs the gate (spawn `git commit` in a fixture repo)
- [x] Test: husky-style repo → block appended to the manager script, no raw `.git/hooks` write,
      no false success on the unrecognized-manager path
- [x] Test: default repo (no hooksPath) → byte-identical install behavior to today
- [x] Test: doctor flags a hook present in `.git/hooks` but shadowed by core.hooksPath
- [x] Test: `enforce --json` and `review --format json` both carry `schemaVersion`; existing
      envelope fields unchanged (enforce.test.ts GateJson assertions still pass)
- [x] Full suite green (`vitest run src examples`)

## Spec
- [x] `cli` delta: ADD HookInstallersTargetTheEffectiveHooksDir,
      MachineJsonEnvelopesCarrySchemaVersion
