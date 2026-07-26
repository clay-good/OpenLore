# Tasks — validate what breaks the run; never bless a config that crashes

## Reproducers (write these first)
- [ ] `{}` config → `openlore analyze` must fail with an attributable error naming the file and the
      missing key. Today: `Analysis failed: Cannot read properties of undefined (reading 'excludePatterns')`
- [ ] `{}` config → `openlore doctor` must report a finding. Today: `✓ Config schema  all keys known
      and well-typed`
- [ ] `analysis.maxFiles: "lots"` → must be reported as a type error. Today: passes silently while an
      unknown key in the same file IS reported
- [ ] Control: a config produced by `openlore init` must produce zero findings and byte-identical
      output to today — a validator that starts flagging healthy configs is a worse bug than the one
      being fixed

## Implementation
- [ ] Schema: mark required sections as required and distinguish absent from present-and-malformed
- [ ] Drift check binding "required in schema" to "dereferenced unconditionally in code", so the two
      cannot diverge (the same self-enforcing shape used by the CLI `--base`/staleness parity guard)
- [ ] Complete type checks for every declared field; a field the validator cannot check must not be
      counted toward a well-typed claim
- [ ] Config read boundary: raise an attributable error naming `.openlore/config.json`, the key, and
      the remedy instead of letting a `TypeError` escape
- [ ] `doctor`'s config check derives its verdict from the same validator the commands use, and its
      summary text describes only what it verified

## Verification
- [ ] Every reproducer fails on `origin/main` and passes after the change
- [ ] Cross-surface agreement test: for a set of configs (valid, empty, missing-section, wrong-type,
      unknown-key), `doctor` and `analyze` never disagree about acceptability
- [ ] Diagnostics continue to go to stderr, so `--json` stdout stays valid (the machine-output
      contract that motivated the original config-warning placement)

## Notes
- [ ] Related but out of scope: `analyze` reporting `Architecture: unknown` and domain names derived
      from filenames (`tsconfig`, `order-service-test`). That is inference quality, not validation.
- [ ] Nothing borrowed from another tool: this is completing OpenLore's own
      `add-config-schema-validation`, not adopting an external schema system.
