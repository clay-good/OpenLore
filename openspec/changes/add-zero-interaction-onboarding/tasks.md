# Tasks — zero-interaction onboarding + passive update notifier

## Implementation
- [x] `scripts/postinstall.mjs` — CI/TTY/dependency-guarded hint; always exit 0; register in package.json + `files`
- [x] `src/core/services/update-notifier.ts` — cached, non-blocking, fail-silent notifier (env + TTY guards)
- [x] `src/cli/commands/update.ts` — `openlore update` (detect npm/Homebrew/npx; `--check`/`--dry-run`)
- [x] `src/core/services/cold-start-bootstrap.ts` — once-per-dir background index build; opt out via `OPENLORE_NO_AUTO_ANALYZE`
- [x] `src/cli/index.ts` — register `update`; wire notifier into `preAction` for human-facing commands only
- [x] `src/cli/commands/connect.ts` — `-y, --yes` non-interactive
- [x] `src/cli/commands/mcp.ts` — call the cold-start bootstrap when starting the in-process watcher
- [x] `README.md` — document the zero-interaction path + `openlore update`; fix under-claiming badges

## Tests
- [x] `update-notifier.test.ts` — isNewer, fetch, cache refresh, notify (print/suppress/background) — 14 cases
- [x] `update.test.ts` — detectInstallMethod, upgradeCommandFor
- [x] `cold-start-bootstrap.test.ts` — runs once / skips when analyzed / disabled / fail-soft
- [x] `connect.test.ts` — `--yes` wires detected agents with no prompt
- [x] e2e smoke: postinstall silent in CI (exit 0); `openlore update --dry-run` reports correctly

## Spec
- [x] `cli` spec: ADD ZeroInteractionOnboarding, ColdStartSelfBootstrap, PassiveUpdateNotifier

## Verification
- [x] `tsc --noEmit` clean
- [x] full suite green (`vitest run` — integration excluded per vitest.config.ts)
- [ ] decisions recorded + gate synced
