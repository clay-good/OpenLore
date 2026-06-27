# config spec delta

## ADDED Requirements

### Requirement: ConfigWritesConfinedToOwnedKey

When OpenLore writes `openspec/config.yaml`, it SHALL confine its writes to its declared owned key
(`openlore`). If a config already exists, OpenLore SHALL preserve every other key and comment
byte-for-byte and SHALL NOT introduce or overwrite a host-owned key (e.g. `version`, `profile`,
`delivery`, `workflows`, `featureFlags`, `plugins`). When the config is host-managed (any host-owned
key is present), OpenLore SHALL additionally skip context auto-injection, since the host owns
`context`. When no config exists, OpenLore MAY create it with `schema`/`context` as the legitimate
creator.

#### Scenario: OpenLore updates only its own block in a host-managed config

- **GIVEN** an `openspec/config.yaml` created by OpenSpec with host-owned keys and a comment
- **WHEN** OpenLore writes its metadata
- **THEN** only the `openlore` block is added or updated and every other key and comment is left
  byte-identical, and no `schema`/`context` key is introduced

#### Scenario: Standalone OpenLore still seeds a fresh config

- **GIVEN** no `openspec/config.yaml` exists
- **WHEN** OpenLore writes its metadata
- **THEN** OpenLore creates the file with `schema: spec-driven` and its `openlore` block

#### Scenario: Host formatting is preserved exactly

- **GIVEN** a host-managed `openspec/config.yaml` using CRLF line endings, an inline
  comment, and a folded scalar
- **WHEN** OpenLore writes its metadata
- **THEN** the `openlore` block is spliced in using the file's line ending and the host
  region — line endings, inline-comment spacing, and the folded scalar — is unchanged
  byte-for-byte

#### Scenario: Malformed host config is never clobbered

- **GIVEN** an `openspec/config.yaml` that is not valid YAML
- **WHEN** OpenLore attempts to write its metadata
- **THEN** OpenLore refuses with a clear error and leaves the file exactly as it was,
  rather than re-serializing or truncating it
