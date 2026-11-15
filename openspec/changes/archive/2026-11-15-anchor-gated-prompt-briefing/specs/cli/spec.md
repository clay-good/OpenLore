# Delta for cli

## MODIFIED Requirements

### Requirement: OrientInjectMode

The system SHALL provide an `--inject` mode on the `openlore orient` command that emits an
injection-shaped orientation block for a single task. The task SHALL be taken from `--task` when
present, otherwise read from the command's stdin (the prompt payload a pre-turn agent hook supplies).
The emitted block SHALL reuse the lean orientation output (Spec 27), SHALL be bounded by a documented
token budget, SHALL be clearly attributed to OpenLore, and SHALL open with a one-line statement that
it is informational and may be ignored (the same facts-not-coercion posture as the Epistemic Lease,
decision `8e95746d`). The mode SHALL be deterministic with no LLM. The mode SHALL be the
prompt-submitted hook moment under its existing command name: it SHALL be turned off by
`hooks.prompt-submitted: false` as well as by `contextInjection.mode: "off"`, SHALL stop at that
moment's runtime limit, and SHALL be listed by `openlore status`. A missing index SHALL be stated as
a single line, once per harness session. A withheld briefing for any other cause SHALL print nothing
on that turn (see `AbsenceOfABriefingIsNeverAmbiguous`). A thrown error or a passed runtime limit
SHALL print nothing and exit 0. A hook that invokes the mode can never break the user's turn.

#### Scenario: Inject emits a budgeted, ignorable block for a real task

- **GIVEN** an analyzed repository and a task that names an indexed function in backticks
- **WHEN** `openlore orient --inject` runs
- **THEN** it emits a lean, OpenLore-attributed orientation block that opens with an
  informational/ignorable framing line and does not exceed the configured token budget

#### Scenario: Inject never breaks the turn

- **GIVEN** a repository with no analysis index
- **WHEN** `openlore orient --inject` runs from a hook
- **THEN** it emits a single line stating that no index is available and exits 0, emitting no
  error to the harness

#### Scenario: An orientation error is silent

- **GIVEN** an analyzed repository where the orientation lookup throws
- **WHEN** `openlore orient --inject` runs from a hook
- **THEN** it prints nothing and exits 0

#### Scenario: The moment's own off switch works

- **GIVEN** `hooks.prompt-submitted: false` in `.openlore/config.json`
- **WHEN** `openlore orient --inject` runs
- **THEN** it prints nothing and exits 0, and `openlore status` marks the moment as off

### Requirement: InjectionRequiresCodeWorkIntent

The pre-turn context injection SHALL emit a structural briefing only for a turn whose intent involves reading or changing code. A turn whose intent is repository or process management — pushing, opening, reviewing, merging or closing a pull request, releasing, tagging, writing a changelog, rebasing, or asking for repository status — SHALL receive no briefing, even when its words match indexed symbols.

The intent classification SHALL be deterministic and local, with no LLM call and no new relevance score. It SHALL run before the anchor gate; a turn that passes the intent gate is still subject to that gate. Classification failure SHALL fail open to the code-work branch.

#### Scenario: Repository-management turn gets no briefing

- **GIVEN** an indexed repository whose graph contains symbols named in the prompt
- **WHEN** the user's turn is "push and open the PR"
- **THEN** the hook emits no structural briefing and records the reason `management-intent`

#### Scenario: Code-work turn still gets its briefing

- **GIVEN** the same repository
- **WHEN** the user's turn is "add a test for `writeFileBrowserEntry`" and that function is indexed
- **THEN** the intent gate passes and the anchor gate decides the briefing

#### Scenario: Unrecognized intent keeps current behavior

- **GIVEN** a turn the intent classifier matches no management pattern in
- **WHEN** the injection is built
- **THEN** the turn is treated as code work and only the anchor gate applies

### Requirement: WithheldInjectionDisclosesItsReason

When the injection is withheld, the hook SHALL record a stable machine-readable reason — at minimum `management-intent`, `no-anchor`, `no-graph`, `empty-prompt`, and `error` — through the existing gate-evaluation callback, and telemetry SHALL carry it. With `OPENLORE_INJECT_DEBUG=1` the reason SHALL be written to stderr, never to the agent's context. Withholding SHALL remain fail-open and exit zero.

#### Scenario: Management-intent withhold is attributable

- **GIVEN** telemetry is enabled
- **WHEN** a turn is withheld by the intent gate
- **THEN** the emitted event carries reason `management-intent`, distinguishable from a `no-anchor` withhold

## ADDED Requirements

### Requirement: PromptBriefingRequiresAnExactAnchor

The `--inject` mode SHALL brief a turn only on code the prompt names. It SHALL extract anchors from
the user's own words — `backticked` names, file paths, and identifier-shaped words (camelCase,
two-hump PascalCase, snake_case, CONSTANT_CASE, `Class.method(`) — and SHALL NOT search prose. Text
inside `<pasted_content>` blocks SHALL NOT supply anchors. The briefing SHALL contain only what an
anchor names exactly: a function whose name, or the last segment of a `Class.method` name, equals an
anchor, or a file that an anchored path names, with their call neighbours. A file under a
`fixtures`, `__fixtures__`, `examples` or `testdata` folder SHALL be shown only for a path anchor
into it. A name that the lookup finds defined in more than two files SHALL NOT be an anchor. When no
anchor resolves exactly, no briefing SHALL be emitted. The rule SHALL be deterministic, local, and
never learned or LLM-derived.

> Replaces the matched-count / centrality / score gate. Audit (2026-11-15): on 68 real code prompts
> that gate briefed 25 turns with 4% file precision; the exact-anchor gate briefs 2, both naming a
> file the agent then worked on (change: anchor-gated-prompt-briefing).

#### Scenario: A process prompt is not searched

- **GIVEN** an analyzed repository
- **WHEN** the prompt is "please fix ci on 708" or "start group 2 and drive it to merge"
- **THEN** no lookup runs and no briefing is emitted

#### Scenario: A named symbol is briefed alone

- **GIVEN** an analyzed repository where `detectExistingSpecDir` is defined once
- **WHEN** the prompt is "why does `detectExistingSpecDir` miss docs/specs?"
- **THEN** the briefing lists `detectExistingSpecDir` and its file and callers, and no other function

#### Scenario: A fixture or an ambiguous name is not an anchor

- **GIVEN** a prompt naming `GetOrder`, defined only in a test fixture, or `main`, defined in many files
- **WHEN** the hook runs
- **THEN** no briefing is emitted

### Requirement: SilenceIsExplainedOncePerSession

What an absent briefing means SHALL be stated to the agent once per harness session, on the first
turn that the intent or anchor gate withholds: briefings are given only when a prompt names code that
resolves exactly in the index, so no briefing means none did, and `orient` searches on demand. Later
withheld turns in the same session SHALL emit nothing. A missing index SHALL be stated as its own
line, once per session. Emitting nothing on every turn SHALL be reserved for an operator who disabled
the moment (`contextInjection.mode: "off"` or `hooks.prompt-submitted: false`), and a hook failure (a
thrown error or a passed runtime limit) SHALL emit nothing and be counted in the hook health that
`openlore status` reports.

> Replaces a pointer line on every withheld turn, which cost context on most turns (change:
> anchor-gated-prompt-briefing).

#### Scenario: Silence is explained once per session

- **GIVEN** an analyzed repository and a harness session
- **WHEN** three process prompts arrive in that session
- **THEN** the first prompt receives the one line explaining silence, and the next two receive nothing
- **AND** a new session receives the line again on its first withheld prompt

#### Scenario: A running build says nothing to the agent

- **GIVEN** an index build or repair is running
- **WHEN** the hook runs
- **THEN** the agent's context gets no build or progress line

#### Scenario: A disabled install stays silent

- **GIVEN** `contextInjection.mode` is `off`
- **WHEN** the hook runs
- **THEN** nothing is emitted

#### Scenario: A failed hook is silent to the agent and counted for the operator

- **GIVEN** injection is enabled and the orientation lookup throws
- **WHEN** the hook runs
- **THEN** the agent receives nothing, and `openlore status` counts one error for the prompt-submitted moment

## REMOVED Requirements

### Requirement: OrientationRelevanceGate

**Reason**: The matched-count / centrality / score gate briefed 25 of 68 real code prompts with 4%
file precision (audit, 2026-11-15).
**Migration**: Replaced by `PromptBriefingRequiresAnExactAnchor`. The `relevanceMin*` settings no
longer affect the prompt hook.

### Requirement: AbsenceOfABriefingIsNeverAmbiguous

**Reason**: A pointer line on every withheld turn cost context on most turns.
**Migration**: Replaced by `SilenceIsExplainedOncePerSession`: the meaning of silence is stated once
per session, and a missing index once per session.

