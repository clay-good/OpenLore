# mcp-handlers spec delta

## ADDED Requirements

### Requirement: EnforcementBaselineRatchet

The enforcement policy SHALL support a fourth categorical class, `frozen`, alongside
`blocking | advisory | off`. An ordinary, non-hook `openlore enforce` run SHALL explicitly
bootstrap each successfully assessed frozen code into a deterministic, human-readable,
VCS-committable baseline under `.openlore/`; an initialized marker SHALL be retained even when
the code has zero findings. Finding identity SHALL be the stable `code` plus `subject`, with a
source-owned stable discriminator where one subject can produce multiple findings, and SHALL
exclude message text and file:line. Hook and review gates SHALL NOT initialize a missing code.

After initialization, the trusted committed baseline SHALL be shrink-only for that code: a
candidate baseline that adds an identity or removes its initialized marker SHALL fail integrity
checking, while an identity whose finding no longer fires SHALL be removed after a complete
assessment. A hook SHALL require that ratchet edit to be staged; review SHALL evaluate the
committed baseline read-only and direct the operator to run `openlore enforce` for the shrink.
An unavailable, partial, malformed, oversized, or unsafe baseline/assessment SHALL preserve the
existing bytes and fail closed for the affected frozen policy instead of initializing or deleting
entries. Baseline-matched findings SHALL report as frozen; absent findings SHALL block as new;
every gate result SHALL disclose disjoint frozen and new counts. A baseline SHALL be written only
for an explicit frozen mapping. Downgrading to advisory SHALL leave it byte-for-byte unchanged,
and re-upgrading SHALL resume against the same ratchet. No tuning constant is introduced.

#### Scenario: Brownfield adoption blocks only new debt

- **GIVEN** a repository with 312 pre-existing findings for a code the operator maps to `frozen`
- **WHEN** the operator bootstraps with non-hook `openlore enforce`, commits the baseline and
  policy, and a later change introduces 2 findings not in that trusted baseline
- **THEN** bootstrap freezes the 312 without blocking, and the later run blocks on exactly
  the 2, disclosing "312 frozen, 2 new → blocked on the 2"

#### Scenario: The ratchet prevents regressions from returning

- **GIVEN** a frozen finding that a developer fixes
- **WHEN** a complete enforce run removes its baseline line, the update is committed, and a later
  change re-introduces the same finding
- **THEN** the re-introduced finding is absent from the trusted baseline and blocks; adding its
  identity back in the candidate change also fails integrity checking

#### Scenario: An empty snapshot cannot silently re-freeze later debt

- **GIVEN** a frozen code that was bootstrapped with zero findings
- **WHEN** its first finding appears in a later change
- **THEN** the retained initialized marker makes that finding new and the gate blocks

#### Scenario: Incomplete assessment never shrinks trusted debt

- **GIVEN** an initialized frozen code with committed finding identities
- **WHEN** its finding source fails, omits candidates, or reaches a reporting cap
- **THEN** the gate discloses incomplete assessment, preserves the baseline byte-for-byte, and
  does not treat the absent results as fixes

#### Scenario: Moving a frozen violation does not un-freeze it

- **GIVEN** a baselined finding whose subject moves to a different line within its file
- **WHEN** the gate re-runs
- **THEN** the finding still matches its baseline entry (identity is code + subject, not
  file:line) and remains frozen

#### Scenario: Downgrading the policy preserves the frozen record

- **GIVEN** a code mapped `frozen` with a committed baseline
- **WHEN** the operator downgrades the code to `advisory`
- **THEN** the gate stops blocking on that code, the baseline file is left untouched, and a later
  re-upgrade to `frozen` resumes against the ratcheted baseline
