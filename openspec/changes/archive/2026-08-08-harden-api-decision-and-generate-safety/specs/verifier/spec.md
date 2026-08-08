# verifier spec delta

## ADDED Requirements

### Requirement: DecisionVerificationDisclosesAbsentEvidence

When decision verification runs without a diff to check against (no git repository, or diff
building failed), the resulting decisions SHALL be marked with absent verification evidence
(a distinct status or an explicit `verificationEvidence: 'none'`), surfaced at the approval
gate/TUI — they SHALL NOT be labeled "verified" identically to diff-verified decisions.

#### Scenario: A non-git consolidation does not claim verification

- **GIVEN** decision consolidation in a workspace that is not a git repository
- **WHEN** the decisions are produced
- **THEN** each is marked as having no verification evidence, distinguishable from a
  diff-verified decision at the approval surface
