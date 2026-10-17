# Spec Delta

## ADDED Requirements

### Requirement: MessageTopologyEdgesFromStaticDiscriminants

The synthesis pass SHALL add a **message-topology edge** from a function that sends a tagged
message to each handler clause that selects the same field and tag, only when the field and both
tags are static in the AST. The rule SHALL use no LLM, SHALL run after direct resolution, and SHALL
only add edges. It SHALL apply to TypeScript/JavaScript only; another language emits no message
edge rather than a guess.

#### Scenario: A send and its switch case are connected

- **GIVEN** a function constructing `{ type: "restart" }` passed to a transport call
- **AND** a consumer containing `switch (msg.type) { case "restart": handleRestart() }`
- **AND** no direct call from the first function to the consumer
- **WHEN** the call graph is built
- **THEN** a synthesized message-topology edge exists from the constructing function to the clause's
  handling function

### Requirement: MessageSitesAreTransportSendsAndClosedFieldConsumers

A construction site SHALL count only when its object literal is passed to a transport call
(`send`, `postMessage`, `dispatch`, …), directly or through `JSON.stringify`, and only for a closed
set of fields (`type`, `kind`, `action`, …). A consumer SHALL be a `switch` over `x.<field>`, or an
`if` whose condition is, or has as one `&&` operand, `x.<field> === <tag>`. A computed tag, or one a
later spread can overwrite, SHALL give no edge.

#### Scenario: An equality test is an equivalent consumer form

- **GIVEN** the same construction site and a consumer containing `if (msg.type === "restart")`
- **WHEN** the call graph is built
- **THEN** the same message-topology edge is synthesized

#### Scenario: A mismatched tag produces no edge

- **GIVEN** a construction site tagged `"open"` and a consumer clause selecting `"close"`
- **WHEN** the call graph is built
- **THEN** no message-topology edge is created between them

#### Scenario: A plain data value is not a message

- **GIVEN** a function returning `{ kind: "calls" }` and a consumer containing `if (e.kind === "calls")`
- **AND** the literal is not passed to a transport call
- **WHEN** the call graph is built
- **THEN** no message-topology edge is created

#### Scenario: A computed tag produces no edge

- **GIVEN** a construction site whose discriminant value is a variable or a template with a
  substitution
- **WHEN** the call graph is built
- **THEN** no message-topology edge is created, and the site is not reported as having no consumers

#### Scenario: Direct and event-channel edges are unchanged

- **GIVEN** a graph built with the message-topology rule enabled and the same graph built with it
  disabled
- **WHEN** the two are compared
- **THEN** every directly-resolved and event-channel edge is identical, and the enabled graph differs
  only by added message-topology edges and the `tested_by` edges derived from those whose caller is
  a test, as for every other synthesized rule

#### Scenario: Two discriminant fields never cross

- **GIVEN** one protocol keyed on `type` and another keyed on `kind`, sharing a tag literal
- **WHEN** the call graph is built
- **THEN** no edge pairs a construction site of one field with a consumer clause of the other

### Requirement: MessageEdgesAreLabelledAndSeparable

A synthesized message-topology edge SHALL carry a provenance label distinguishing it from a
directly-resolved call and from an event-channel edge. Every consumer that reports paths, callers,
or blast radius SHALL be able to identify and exclude message-topology edges, and SHALL NOT present
such an edge as a proven call at run time: the edge states that a message constructed here can be
selected by that handler, not that the hop occurs on any particular execution.

#### Scenario: A path discloses the hop kind

- **GIVEN** a path traversing a message-topology edge
- **WHEN** `find_path` reports the path
- **THEN** the step that edge reaches carries `via: "message-topology"`, and the call hops around it
  carry no `via`

#### Scenario: A consumer can exclude message edges

- **GIVEN** a traversal that asks for directly-resolved edges only
- **WHEN** it runs over a graph containing message-topology edges
- **THEN** those edges are excluded and the result matches the graph built without the rule

### Requirement: UnpairedMessageSendsAreDisclosedAsTransportBoundaries

A send that no indexed clause can be paired with SHALL be recorded as a `message-send`
dynamic-boundary site with the most specific reason: `over-cap`, `unattributed-caller` (a handler
exists but no indexed function contains the send), `uncomparable-message-consumer` (a clause tests
the field against a constant that cannot be compared), or `unindexed-message-consumer`. No edge
SHALL be invented to an unindexed consumer.

#### Scenario: A message leaving the indexed repository is disclosed

- **GIVEN** a statically tagged message sent to a service whose handler is not in the index
- **WHEN** the call graph is built
- **THEN** the site is recorded as a transport boundary with its reason, and no edge is synthesized

#### Scenario: The boundary is visible to consumers asking about that symbol

- **GIVEN** a recorded transport boundary in a function
- **WHEN** a consumer reports that function's outgoing structure
- **THEN** the boundary is disclosed, so an empty message fan-out is never read as proof of absence

#### Scenario: An uncomparable consumer is not called absent

- **GIVEN** a send of `{ type: types.CHECKOUT_REQUEST }` and a clause `case CHECKOUT_REQUEST:` on
  `action.type`, where the constant is imported
- **WHEN** the call graph is built
- **THEN** no edge is synthesized, and the send's site carries `uncomparable-message-consumer`

#### Scenario: A send outside any indexed function is still disclosed

- **GIVEN** a send inside an anonymous callback at module level, with an indexed handler
- **WHEN** the call graph is built
- **THEN** the send is a `message-send` site marked unattributed with `unattributed-caller`

### Requirement: TestFileHandlersPairOnlyWithinTheirFile

A handler clause in a test file SHALL pair only with a send in the same file, because a test's
protocol (a fake worker, a local reducer) is its own. A send in a test file MAY pair with a handler
in production code.

#### Scenario: A generic tag does not cross unrelated tests

- **GIVEN** `dispatch({ type: "INCREMENT" })` in one test file and a reducer selecting `"INCREMENT"`
  in another test file
- **WHEN** the call graph is built
- **THEN** no edge connects them, while a send in the reducer's own file does pair with it

### Requirement: SingleFileMessageBoundariesClaimNoRepositoryWideAbsence

The single-file dynamic-boundary re-derive SHALL pair a send only against that file's own handler
clauses, and SHALL record any other send as `unresolved-in-file-scope`, never as
`unindexed-message-consumer`: one file cannot show that no handler exists elsewhere.

#### Scenario: A one-file re-derive stays in its scope

- **GIVEN** a file with two sends, one of whose tags a clause in the same file selects
- **WHEN** that file's dynamic-boundary record is re-derived on its own
- **THEN** only the other send is a site, and its refusal is `unresolved-in-file-scope`

### Requirement: MessageTopologySupportIsDeclaredPerLanguage

The language-support matrix SHALL declare message-topology recovery per language, so a language
without it reports an unsupported capability rather than an empty result. A language SHALL be
declared supported only when its construction and consumer idioms are both recovered by an
implemented collector.

#### Scenario: An unsupported language reports the gap

- **GIVEN** a repository whose message protocol is written in a language with no message-topology
  collector
- **WHEN** the language-support matrix is queried for that language
- **THEN** message topology is reported unsupported, and a quiet result is interpretable as such

#### Scenario: A supported language is declared from its implementation

- **GIVEN** the language whose collector this change implements
- **WHEN** the matrix is queried
- **THEN** message topology is reported supported for that language only
