## ADDED Requirements

### Requirement: InjectionRequiresCodeWorkIntent

The pre-turn context injection SHALL emit a structural briefing only for a turn whose intent involves reading or changing code. A turn whose intent is repository or process management — pushing, opening, reviewing, merging or closing a pull request, releasing, tagging, writing a changelog, rebasing, or asking for repository status — SHALL receive the pointer line instead of a briefing, even when its words match indexed symbols.

The intent classification SHALL be deterministic and local, with no LLM call and no new relevance score. It SHALL run before the existing relevance gate; a turn that passes the intent gate is still subject to that gate. Classification failure SHALL fail open to the code-work branch, so an unrecognized turn keeps today's behavior.

#### Scenario: Repository-management turn gets no briefing

- **GIVEN** an indexed repository whose graph contains symbols named in the prompt
- **WHEN** the user's turn is "push and open the PR"
- **THEN** the hook emits the pointer line and no structural briefing

#### Scenario: Code-work turn still gets its briefing

- **GIVEN** the same repository
- **WHEN** the user's turn is "add a test for the file browser's write path"
- **THEN** the intent gate passes and the relevance gate decides the block as it does today

#### Scenario: Unrecognized intent keeps current behavior

- **GIVEN** a turn the intent classifier matches no management pattern in
- **WHEN** the injection is built
- **THEN** the turn is treated as code work and only the relevance gate applies

### Requirement: WithheldInjectionDisclosesItsReason

When the injection is withheld, the hook SHALL record a stable machine-readable reason — at minimum `management-intent`, `weak-relevance`, `no-graph`, `empty-prompt`, and `error` — through the existing gate-evaluation callback, and telemetry SHALL carry it. Withholding SHALL remain fail-open and exit zero.

#### Scenario: Management-intent withhold is attributable

- **GIVEN** telemetry is enabled
- **WHEN** a turn is withheld by the intent gate
- **THEN** the emitted event carries reason `management-intent`, distinguishable from a weak-relevance withhold

### Requirement: AbsenceOfABriefingIsNeverAmbiguous

While injection is enabled, the hook SHALL always emit output. A withheld briefing SHALL be replaced by a pointer line that states, in the agent-visible text, that the gate withheld it and why — at minimum distinguishing "this turn was not classified as code work" from "nothing in the graph matched this turn strongly" and from "orientation was unavailable" — and SHALL name the manual call that retrieves the structure on demand.

The agent SHALL never have to infer whether an absent briefing means "nothing relevant was found" or "no lookup was performed". Emitting nothing SHALL be reserved for an operator who disabled injection (`mode: "off"`), which is a configured absence, not a gate decision.

This requirement bounds the intent gate's failure mode: a misclassified code-work turn loses the pre-computed briefing but never the knowledge that a briefing was skipped, nor the way to ask for one.

#### Scenario: A misclassified turn still tells the agent what happened

- **GIVEN** a code-work turn the intent gate wrongly classifies as repository management
- **WHEN** the hook runs
- **THEN** the agent receives a pointer line stating the turn was not classified as code work and naming the manual orientation call

#### Scenario: Weak relevance is distinguishable from a skipped lookup

- **GIVEN** two turns, one withheld for weak relevance and one withheld by the intent gate
- **WHEN** each hook runs
- **THEN** the two pointer lines differ in their stated reason, so absence never reads the same for both causes

#### Scenario: An enabled install never emits silence

- **GIVEN** injection is enabled in any mode other than `off`
- **WHEN** the hook runs on any turn, including failure paths
- **THEN** the output is non-empty and carries a stated reason

#### Scenario: A disabled install stays silent

- **GIVEN** `contextInjection.mode` is `off`
- **WHEN** the hook runs
- **THEN** nothing is emitted, and no pointer line implies a gate decision
