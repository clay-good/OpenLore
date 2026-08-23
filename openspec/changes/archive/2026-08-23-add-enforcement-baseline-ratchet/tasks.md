# Tasks — add-enforcement-baseline-ratchet

## Implementation
- [x] Add `frozen` to the `EnforcementClass` union (types/index.ts:97), `ENFORCEMENT_CLASSES`
      (enforcement-policy.ts:35), and the `resolveEnforcementClass` ladder
      (enforcement-policy.ts:186); categorical only, no constants
- [x] Baseline module beside enforcement-policy.ts: bounded deterministic JSON-lines under
      `.openlore/`, initialized-code markers plus one sorted identity line (`code` + `subject` +
      source-owned stable discriminator; never message/file:line); strict version header,
      symlink refusal, atomic writes, malformed/oversized state preserved and failed closed
- [x] Gate semantics in `openlore enforce` (src/cli/commands/enforce.ts, incl. --hook): frozen +
      in-baseline → labeled advisory; frozen + new → blocks; disclosure line "N frozen, M new →
      blocked on the M"
- [x] Trusted shrink-only ratchet: complete assessments remove retired entries; candidate growth
      or initialized-marker removal for a trusted code fails integrity; hooks require the ratchet
      diff to be staged and never initialize missing codes
- [x] Frozen semantics for review's blast-radius orphan findings / bundled Action, read-only
      against the trusted base baseline; policy downgrade frozen→advisory preserves baseline bytes
- [x] Managed Git ignore rules make both `.openlore/config.json` and the baseline visible to
      ordinary staging; malformed managed blocks fail closed instead of being silently replaced

## Verification
- [x] Brownfield simulation: N pre-existing findings + code mapped `frozen` → first run freezes N
      (exit 0, baseline written); introducing 1 new finding → gate blocks on exactly that 1, with
      the "N frozen, 1 new" disclosure
- [x] Ratchet test: fix a frozen finding → next run removes its baseline line; re-introducing the
      same finding then BLOCKS (it cannot re-freeze silently)
- [x] Line-insensitivity test: move a frozen violation to a different line/file position without
      changing code+subject identity → still frozen, no block
- [x] Downgrade test: frozen→advisory stops blocking but preserves the baseline file byte-for-byte;
      re-upgrade resumes against the ratcheted baseline
- [x] Baseline is human-readable and deterministic (sorted, stable across runs — snapshot pinned);
      no baseline is ever written without a `frozen` policy entry
- [x] Integrity tests: trusted-baseline growth laundering, missing/unknown header, duplicate or
      colliding identity, symlink/race-safe bounded reads, over-limit output, lock failure, partial
      assessment, and staged-vs-working-tree hook mismatch all preserve state and fail closed
- [x] Zero-finding initialization retains its marker; exact duplicates count once; aggregate
      finding producers emit stable per-underlying-finding identities
- [x] Review JSON schema v2 includes bounded enforcement evidence; enforce JSON schema v3 exposes
      disjoint frozen/new partitions and the exact 312 frozen / 2 new receipt
- [x] Full suite green

## Spec
- [x] `mcp-handlers` delta: ADD EnforcementBaselineRatchet
