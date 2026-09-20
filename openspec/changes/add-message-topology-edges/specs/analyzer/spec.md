# Spec Delta

## ADDED Requirements

### Requirement: MessageTopologyEdgesFromStaticDiscriminants

The dynamic-dispatch synthesis pass SHALL recover **message-topology edges**: an additive edge from
the function that constructs a tagged message value to each handler clause that selects on the same
discriminant. An edge SHALL be emitted only when all of the following are static in the AST: the
discriminant field name, the tag literal at the construction site, and the tag literal the consumer
compares. The rule SHALL NOT use an LLM, SHALL run after direct resolution, and SHALL only add
edges — never modify or remove a directly-resolved or event-channel edge.

The discriminant field SHALL be resolved from a declared discriminated-union type when that type is
in the index, and otherwise from the member expression the consumer tests. A message whose tag is
computed, spread from another value, or renamed between construction and consumption SHALL produce
no edge.

Recovery is per-language under the same discipline as event channels: a language whose construction
or consumer idiom is not statically pairable SHALL emit no message edges rather than guess. The set
in effect for this requirement is TypeScript/JavaScript.

#### Scenario: A send and its switch case are connected

- **GIVEN** a function constructing `{ type: "restart" }` passed to a transport call
- **AND** a consumer containing `switch (msg.type) { case "restart": handleRestart() }`
- **AND** no direct call from the first function to the consumer
- **WHEN** the call graph is built
- **THEN** a synthesized message-topology edge exists from the constructing function to the clause's
  handling function

#### Scenario: An equality test is an equivalent consumer form

- **GIVEN** the same construction site and a consumer containing `if (msg.type === "restart")`
- **WHEN** the call graph is built
- **THEN** the same message-topology edge is synthesized

#### Scenario: A mismatched tag produces no edge

- **GIVEN** a construction site tagged `"open"` and a consumer clause selecting `"close"`
- **WHEN** the call graph is built
- **THEN** no message-topology edge is created between them

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
  only by added message-topology edges

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
- **WHEN** the path is reported
- **THEN** the hop is labelled as a message edge, distinct from the call hops around it

#### Scenario: A consumer can exclude message edges

- **GIVEN** a traversal that asks for directly-resolved edges only
- **WHEN** it runs over a graph containing message-topology edges
- **THEN** those edges are excluded and the result matches the graph built without the rule

### Requirement: UnpairedMessageSendsAreDisclosedAsTransportBoundaries

A construction site with a static discriminant whose consumers are not present in the index SHALL be
recorded as a transport boundary carrying the reason it was not paired, in the same way the analyzer
already discloses dispatch sites it cannot follow. It SHALL NOT be reported as having no consumers,
and no edge SHALL be invented to an unindexed consumer.

#### Scenario: A message leaving the indexed repository is disclosed

- **GIVEN** a statically tagged message sent to a service whose handler is not in the index
- **WHEN** the call graph is built
- **THEN** the site is recorded as a transport boundary with its reason, and no edge is synthesized

#### Scenario: The boundary is visible to consumers asking about that symbol

- **GIVEN** a recorded transport boundary in a function
- **WHEN** a consumer reports that function's outgoing structure
- **THEN** the boundary is disclosed, so an empty message fan-out is never read as proof of absence

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
