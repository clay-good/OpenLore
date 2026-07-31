# mcp-handlers spec delta

## ADDED Requirements

### Requirement: RegisteredRepoFreshnessIsBaselined

A federation registry entry whose stored fingerprint is empty (a repo registered before its first
`openlore analyze`) SHALL NOT be reported as plain `indexed`: until a fingerprint baseline exists,
its state SHALL be an explicit `unbaselined` disclosure stating that staleness cannot yet be
assessed, with remediation. When a federation status or consult path observes a live index
fingerprint for such an entry, it SHALL adopt that fingerprint as the stored baseline (persisted
through the existing atomic registry write), so that subsequent drift is detected as `stale`. The
staleness verdicts for entries that already carry a baseline SHALL be unchanged. No entry SHALL be
able to report `indexed` indefinitely while its index drifts.

#### Scenario: A pre-analyze registration is disclosed, then baselined

- **GIVEN** a repo registered into the federation before its first `openlore analyze` (stored
  fingerprint empty)
- **WHEN** the repo's index is later built and `federation_status` runs
- **THEN** the entry is reported `unbaselined` (or the live hash is adopted in the same call and
  the adoption disclosed) — never plain `indexed` with an empty baseline
- **AND** after adoption, a subsequent index change is reported `stale`

#### Scenario: Adoption requires a live index

- **GIVEN** an empty-fingerprint entry whose repo has no built index
- **WHEN** a status path evaluates it
- **THEN** the state remains `unindexed` and no baseline is written

#### Scenario: spec_store_status inherits the honest state

- **GIVEN** a spec-store target bound to an unbaselined federation entry
- **WHEN** `spec_store_status` resolves the target
- **THEN** the target's status discloses the unbaselined condition rather than implying a
  freshness-checked `indexed` state

### Requirement: FederationStatusDegradesToConclusion

`federation_status` SHALL degrade an unreadable or malformed federation registry
(`.openlore/federation.json`) to a conclusion-shaped result — naming the file, the parse or shape
error, and the remediation — rather than propagating a raw exception to the transport. The
degradation SHALL match the shape its sibling `spec_store_status` already returns for the
identical failure (`registry-unreadable`).

#### Scenario: A corrupt registry yields a finding, not a throw

- **GIVEN** a `.openlore/federation.json` containing invalid JSON or an unexpected shape
- **WHEN** `federation_status` is called
- **THEN** the tool returns a conclusion identifying the registry as unreadable, with the file
  path and a remediation step (fix or delete the file)
- **AND** no raw exception reaches the MCP transport
