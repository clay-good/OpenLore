## ADDED Requirements

### Requirement: EveryDraftReachesAReasonedVerdict

Consolidation SHALL assign every draft a terminal disposition — `promoted`, `merged-into` with the surviving decision id, or `rejected` — together with a stable reason code drawn from a source-declared registry. A draft SHALL NOT be removed, skipped, or left pending without a disposition.

The disposition and its reason SHALL be persisted with the draft id, so the verdict outlives the background run that produced it.

#### Scenario: A rejected draft carries its reason

- **GIVEN** a draft whose subject matter no supporting diff evidence covers
- **WHEN** consolidation runs
- **THEN** the draft is recorded `rejected` with reason `no-supporting-diff`, retrievable by its id

#### Scenario: A merged draft names its survivor

- **GIVEN** two drafts describing the same decision
- **WHEN** consolidation merges them
- **THEN** the absorbed draft is recorded `merged-into` with the id of the surviving decision

#### Scenario: No draft disappears

- **GIVEN** any set of drafts
- **WHEN** consolidation completes
- **THEN** every input draft has a persisted disposition, and the count of dispositions equals the count of drafts

### Requirement: RecordDecisionDisclosesDraftStatusAndVerdict

`record_decision` SHALL state in its response that it records a draft subject to diff-grounded consolidation, return the draft id, and name the exact command that reads the verdict. Its tool description SHALL describe the same contract; it SHALL NOT imply that the decision is final on return.

A `record_decision` call whose content and anchors match an already-decided draft SHALL return that draft's disposition and reason instead of silently creating a second draft.

#### Scenario: The caller learns where to read the outcome

- **WHEN** `record_decision` succeeds
- **THEN** the response carries the draft id, the draft status, and the exact command that reports its disposition

#### Scenario: Re-recording a rejected draft returns the verdict

- **GIVEN** a draft already rejected with reason `not-architectural`
- **WHEN** the same content and anchors are recorded again
- **THEN** the response reports the existing disposition and reason rather than creating a new pending draft

### Requirement: AuthorStatementSurvivesConsolidationRewrite

When consolidation re-derives a decision's content from diff evidence, the agent-recorded title and rationale SHALL be retained as `authorStatement` on the resulting decision, and the response SHALL disclose that the served content is `llm-extracted` with `verificationEvidence: git-diff`. Recorded author text SHALL never be discarded or rewritten in place.

#### Scenario: The author can see what replaced their wording

- **GIVEN** a draft promoted with re-derived content
- **WHEN** the decision is read
- **THEN** the served content is disclosed as `llm-extracted` and the original author title and rationale are present as `authorStatement`
