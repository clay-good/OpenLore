## ADDED Requirements

### Requirement: PiIsAFirstClassManagedInstallSurface

The CLI SHALL support Pi through automatic install-surface detection, explicit
`openlore install --agent pi`, `openlore connect pi`, and connection status. It SHALL install
a JavaScript shim that loads the compiled extension from inside the OpenLore package rather
than copying compiled output whose relative imports cannot resolve at the destination.

The CLI SHALL preserve user-authored Pi extensions by default. It MAY replace a
fingerprint-valid OpenLore shim, a stale OpenLore shim, or a compiled copy identified by
OpenLore-specific provenance, and SHALL require `--force` before replacing or deleting an
unrecognized file. Dry-run SHALL report the same writes and deletions that a real run would
perform.

#### Scenario: Pi is installed through the primary onboarding path

- **GIVEN** a project with a Pi marker, or an explicit Pi surface selection
- **WHEN** `openlore install` or `openlore connect pi` runs
- **THEN** `.pi/extensions/openlore.js` is a managed re-export shim that Pi can load
- **AND** no MCP registration or markdown guidance block is written for Pi

#### Scenario: A broken historical artifact is migrated

- **GIVEN** `.pi/extensions/openlore.js` is a copied OpenLore bundle whose package-relative
  imports cannot resolve, or is an intact shim pointing at an old OpenLore location
- **WHEN** the Pi install surface runs without `--force`
- **THEN** the file is replaced with a shim pointing at the current OpenLore package
- **AND** a recognized legacy `.ts` artifact is removed only after the shim is present

#### Scenario: User-authored extension content is preserved

- **GIVEN** a Pi extension path containing content OpenLore cannot prove it owns
- **WHEN** install or uninstall runs without `--force`
- **THEN** the content remains unchanged
- **AND** the CLI reports the ownership conflict or warning
