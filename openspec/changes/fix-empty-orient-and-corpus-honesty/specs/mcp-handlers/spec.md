# mcp-handlers spec delta

## ADDED Requirements

### Requirement: EmptyOrientationsExplainThemselves

An `orient` result with no relevant functions SHALL carry a deterministic empty-result
disclosure: the identifier-shaped query tokens that matched nothing in the corpus, and, for each,
any indexed identifier token that contains the missed token as a prefix or substring (a
"near token" receipt, bounded lookup over the existing corpus vocabulary — no model, no new
index). The disclosure SHALL state facts about the miss, never guess an answer.

#### Scenario: A morphological miss names its near token

- **GIVEN** a keyword-mode index whose only matching identifier is `greet`
- **WHEN** `orient` runs for the task "change the greeting"
- **THEN** the empty payload discloses that `greeting` matched nothing and that `greet` is an
  indexed near token

#### Scenario: A genuinely foreign query discloses the miss without a near token

- **GIVEN** the same index
- **WHEN** `orient` runs for "kubernetes ingress rules"
- **THEN** the payload discloses the missed tokens and contains no fabricated near token

### Requirement: NextStepsAreConditionedOnResultShape

The `nextSteps` (and equivalent guidance fields) of an orientation SHALL be conditioned on the
result's shape. An empty briefing SHALL suggest actions appropriate to a miss — an identifier-
style `search_code`, `get_map`, and the near-token receipt when present — and SHALL NOT carry
implement-then-verify workflow steps that presuppose results. A populated briefing keeps the
existing guidance.

#### Scenario: An empty briefing does not advise recording decisions

- **GIVEN** an orient call that matches nothing
- **WHEN** the payload is served
- **THEN** `nextSteps` contains miss-appropriate suggestions and does not contain the
  record_decision / check_spec_drift boilerplate

### Requirement: UserFacingFunctionCountsAgree

Every user-facing count of indexed functions (the analyze/install epilogue's "Function index
built (N functions)") SHALL agree with the call-graph function count for the same analysis, or
SHALL state exactly what else it includes. Two counts of the same population in one output SHALL
NOT silently differ.

#### Scenario: The epilogue counts match

- **GIVEN** a repository whose call graph contains 5 functions
- **WHEN** install's index build completes
- **THEN** the function-index message reports 5, or explicitly names the additional entries it
  counted
