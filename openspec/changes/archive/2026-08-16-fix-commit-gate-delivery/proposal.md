# Fix commit-gate delivery: install hooks where git actually looks, and version the machine contract

> Status: BUILT (2026-08-16). OpenLore's hook installers previously hard-coded
> `<root>/.git/hooks/pre-commit` and never consult `core.hooksPath` — under husky/lefthook/custom
> hooksPath, git never reads `.git/hooks`, so the gate the user believes protects them is inert
> while both installers print success. And the `openlore enforce --json` envelope CI consumes has
> no schemaVersion, unlike its sibling contracts. Install into the effective hooks dir, warn
> honestly when a hook manager owns it, teach `doctor` to check reachability, version the envelope.

## The gap

> **Coordination note from `fix-drift-gate-blindness` (shipped):** there is a THIRD hooksPath-ignoring
> installer this change's "both installers" wording does not name — the drift-hook installer in
> `src/cli/commands/drift.ts:173-207` also hard-codes `<root>/.git/hooks/pre-commit`. The
> `git rev-parse --git-path hooks` resolution below must extend to `drift.ts` as well, or the drift
> gate stays inert under husky/lefthook after enforce/decisions are fixed.

- **The gate can be silently inert.** `installEnforcementHook` joins `rootPath, '.git', 'hooks'`
  unconditionally (`enforce.ts:71-98`) and prints "installed at .git/hooks/pre-commit"
  (`enforce.ts:96`); the decisions-gate `installPreCommitHook` does the same
  (`decisions.ts:202-240`, success at `:240`). Neither — nor anything else in
  `src/cli/commands/` — ever reads `core.hooksPath` (verified: zero matches for `hooksPath`
  across `enforce.ts`, `decisions.ts`, `setup.ts`). When a repo uses husky, lefthook, or any
  custom `core.hooksPath`, git ignores `.git/hooks` entirely: every commit sails past the
  decisions gate and the enforcement gate, yet the user saw a success message. This is the exact
  failure class the honesty contract exists for — a protection that reports itself present while
  being unreachable.
- **No compatibility signal on the machine contract.** The `enforce --json` envelope
  (`enforce.ts:274-282`: `gated`/`blocking`/`advisory`/`off`/`unknownPolicyCodes`/`caveats`) has
  no `schemaVersion`, while the sibling decisions store carries `version: '1'` (visible in
  `enforce.test.ts:57` vs the envelope type at `:72-76`). `review --format json` has the same gap
  (verified: zero `schemaVersion` matches in `review.ts`). A CI consumer parsing these envelopes
  gets no signal when a field is renamed or re-shaped.

## What changes

1. **Resolve the effective hooks dir.** All hook installers resolve it via
   `git rev-parse --git-path hooks` (execFile array-args, honoring `core.hooksPath`, worktrees,
   and `$GIT_DIR`) and install there instead of the hard-coded path. The existing marker-based
   stacking (`enforce.ts:88-91`, `decisions.ts:229-234`) is unchanged — it just operates on the
   right file.
2. **Hook managers get honesty, not a clobber.** When the effective hooks dir belongs to a
   detected manager (path contains `.husky`, or a `lefthook.yml`/equivalent config is present),
   the installer does NOT blindly drop a raw hook file: for husky it appends the openlore block
   to the manager's `pre-commit` script (same marker discipline); where no safe wiring exists it
   emits an explicit, actionable warning naming the manager, the effective dir, and the one-line
   wiring to add — and it never prints the plain success line in that case. No silent success
   over an inert gate.
3. **`openlore doctor` checks reachability.** A new doctor check resolves the effective hooks dir
   and reports whether an openlore hook block is present there and executable — "installed but
   unreachable" (a stale `.git/hooks/pre-commit` shadowed by `core.hooksPath`) is a named failure
   with a fix hint.
4. **Version the envelopes.** `enforce --json` gains `schemaVersion: 1` (`enforce.ts:274-282`);
   `review --format json` gains the same field. Additive — existing consumers ignore an extra key.

Retained as-is (already solid, not re-fixed): hook stacking via distinct markers so the two gates
and third-party hooks coexist (`enforce.ts:88-91`, `decisions.ts:229-234`), the fail-open
node-absent probes inside the hook script (`enforce.ts:47-64`, `ENFORCE_EXIT=0` when no openlore
is resolvable), and the corrupt-settings refusal in setup (`setup.ts:305-324`).

## Why this is in scope

The decisions gate and `openlore enforce` are the substrate's governance teeth; a gate that
installs into a directory git never consults is silent degradation reported as success — the
doctrine's central prohibition. The fix is one `git rev-parse` shell-out plus honest messaging,
fully local and deterministic; the schemaVersion field is the same versioning discipline the
decisions store already practices.

## Impact

- Files: `src/cli/git-hooks.ts` (shared resolution and atomic mutation), all hook-installing CLI
  commands, `src/cli/commands/doctor.ts` (reachability check),
  `src/cli/commands/review.ts` (`schemaVersion` in the JSON envelope); tests for each.
- Specs: `cli` — 2 ADDED (HookInstallersTargetTheEffectiveHooksDir,
  MachineJsonEnvelopesCarrySchemaVersion).
- Tool surface: unchanged (no MCP tool touched, no payload-budget impact; CLI-only).
- Risk: low. Repos without `core.hooksPath` resolve to `.git/hooks` exactly as today; the new
  JSON field is additive; the only behavior removed is a false success message.
