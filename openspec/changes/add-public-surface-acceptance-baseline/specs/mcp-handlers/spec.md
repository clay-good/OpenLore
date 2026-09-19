# mcp-handlers spec delta

## ADDED Requirements

### Requirement: AcceptedBreakageBaselineRequiresJustification

The system SHALL support recording intentionally accepted breaking changes in a checked-in,
human-readable baseline at `.openlore/public-surface-baseline.jsonl`: a fixed header line, then one
sorted JSON record per accepted breakage naming the rule code, the subject (`file::symbol`), the
finding's discriminator (which break: the before and after signature, or the rename target), a
justification, and an optional decision id. An entry SHALL match only a finding with the same
code, subject, and discriminator, so accepting one break never hides a later, different break of
the same rule on the same symbol. Only breaking-classed public-surface rule codes SHALL
be acceptable. An acceptance entry SHALL require a justification — the accept operation
(`openlore certify-public-surface --base <ref> --accept --justification <why>`) refuses without
one, before any analysis runs, and writes nothing. An acceptance MAY anchor to a recorded decision
id, which SHALL be current when the acceptance is written; the acceptance then participates in the
decision store's supersede lifecycle: an acceptance whose decision is superseded, rejected, or not
recorded SHALL be flagged stale (citing the live superseder when there is one) rather than honored
silently, and re-accepting such an entry without a new current decision SHALL be refused rather
than silently removing its anchor. Diff mode SHALL report only findings beyond the baseline in `findings[]`, listing
baseline-matched findings as `accepted` (with their justification) rather than omitting them;
the verdict, per-class summary, and suggested bump SHALL still count an accepted breaking change.
A baseline that cannot be read or parsed SHALL honor no acceptance and SHALL say why, and the accept
operation SHALL NOT overwrite it, nor accept findings computed against a fallback base. The baseline
SHALL stay trackable by Git while the rest of `.openlore/` (including `config.json`) stays ignored,
through a managed `.gitignore` block of its own placed after the enforcement ratchet's block, which
it SHALL NOT edit.
This baseline is the surface-specific complement of the generic frozen-class ratchet
(`EnforcementBaselineRatchet`); the two share the `code` + `subject` identity vocabulary and
compose rather than compete.

- **Implementation**: `applyAcceptedBaseline::src/core/services/mcp-handlers/public-surface-baseline.ts`

#### Scenario: Acceptance requires a reason

- **GIVEN** a breaking finding the operator wants to accept
- **WHEN** `certify-public-surface --accept` is invoked without a justification
- **THEN** the command refuses and writes nothing

#### Scenario: An accepted break stops blocking but stays visible

- **GIVEN** a baseline entry for `export-removed` on symbol `parseLegacy` with a justification
- **WHEN** the same finding fires on a later run
- **THEN** it is reported as `accepted` (with the justification), contributes no finding to
  `findings[]`, and any NEW breaking finding still reports normally

#### Scenario: A superseded decision anchor expires the acceptance

- **GIVEN** an acceptance anchored to decision `a1b2c3d4`, which is later superseded
- **WHEN** the verdict is assembled
- **THEN** the acceptance is flagged stale (citing the live superseder) instead of silently
  suppressing the finding

#### Scenario: A different break of the same rule still reports

- **GIVEN** an acceptance of `param-type-narrowed` on `foo` for narrowing parameter `a`
- **WHEN** a later change also narrows parameter `b`
- **THEN** the new `param-type-narrowed` finding is reported, and the old entry is listed as
  unmatched

#### Scenario: A corrupt baseline honors nothing

- **GIVEN** a baseline file with an invalid record
- **WHEN** the verdict is assembled
- **THEN** every breaking finding is reported, and the baseline block states why no acceptance
  was honored

### Requirement: ConsumerWeightedBreakingVerdicts

Each breaking change SHALL carry a split class: `breaking-consumed` (at least one indexed consumer
binds the symbol; the consumer list and the consumer count are the evidence) or
`breaking-unconsumed-in-index` (zero indexed consumers). Indexed consumers SHALL include resolved
callers, files that import the symbol (so a const, class, or type counts), and — for a symbol no
longer defined under its name — unresolved calls to that name from files that import it, each
labeled with how it binds. The change's `breaking` class, the overall
verdict, and the suggested bump SHALL be unchanged by the split. The external/unindexed-consumer
boundary SHALL remain disclosed on both splits — zero indexed consumers is NEVER presented as
"safe". With federation scope requested, consumers in indexed sibling repos SHALL count toward
`breaking-consumed` via the existing cross-repo consumer resolution (matched by symbol name), and
the verdict SHALL name the repos consulted and skipped, attribute capped consumers to their own
symbol, and disclose breaking changes that share a name; without federation scope, or when no
sibling repo was consulted, the disclosure SHALL honestly state that only in-repo consumers were
checked.

- **Implementation**: `assembleSurfaceDiff::src/core/services/mcp-handlers/public-surface.ts`

#### Scenario: A consumed break names its consumers

- **GIVEN** a breaking change to a symbol with three indexed callers
- **WHEN** the diff verdict is assembled
- **THEN** the change is classed `breaking-consumed` and lists the three consumers as evidence

#### Scenario: An index built after the change still sees the consumers

- **GIVEN** a removed export whose caller still calls it, in an index rebuilt after the removal
- **WHEN** the diff verdict is assembled
- **THEN** the change is `breaking-consumed`, citing the caller as an unresolved call

#### Scenario: Zero indexed consumers is not "safe"

- **GIVEN** a breaking change to a symbol with no indexed caller
- **WHEN** the diff verdict is assembled
- **THEN** the change is classed `breaking-unconsumed-in-index` and the external-consumer
  known-unknowable boundary is still disclosed

#### Scenario: Federation widens the consumer census honestly

- **GIVEN** a breaking change whose only consumer lives in an indexed sibling repo
- **WHEN** the verdict is assembled with federation scope
- **THEN** the change is `breaking-consumed` citing the cross-repo consumer; without federation
  scope it is `breaking-unconsumed-in-index` with a disclosure that sibling repos were not checked
