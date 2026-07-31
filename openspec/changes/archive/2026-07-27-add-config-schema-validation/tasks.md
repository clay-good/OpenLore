# Tasks — add-config-schema-validation

## Implementation
- [x] Validator for `OpenLoreConfig` (generated JSON schema or hand-maintained structural
      validator — dependency-light, deterministic)
- [x] Completeness test binding validator to the type: a new `OpenLoreConfig` field without a
      validator entry fails CI
- [x] `readOpenLoreConfig` runs validation: unknown keys (+ did-you-mean via edit distance against
      known keys), type mismatches, version skew — warnings via existing logger, deduplicated per
      process; NEVER a hard failure
- [x] Newer-version / unknown-key configs degrade gracefully: disclosed as possibly-newer, then
      ignored (forward compat preserved, silence ended)
- [x] Version stamp becomes live: bump on schema change; deterministic migrations where they
      exist; otherwise an explicit older-version report
- [x] `openlore doctor` reports config findings (unknown keys, mismatches, version skew)

## Verification
- [x] Test: `pancResponse` / `embeding` typos → warning with did-you-mean; defaults still apply
- [x] Test: valid config → zero warnings, identical behavior to today
- [x] Test: config with a newer version stamp / unknown future key → disclosed, not crashed on
- [x] Test: older-version config → migrated or explicitly reported
- [x] Test: type-completeness guard fails when a field is added without a validator entry
- [x] Hub-caller check: warnings deduplicated (one emission per process, not per read)
- [x] Full suite green

## Spec
- [x] `config` delta: ADD ConfigUnknownKeysAreDisclosed, ConfigVersionIsChecked
