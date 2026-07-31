# mcp-handlers spec delta

## ADDED Requirements

### Requirement: DataFlowVerdictsAreSoundlyBounded

`trace_data_flow` SHALL return either `flow-found` with an ordered, replayable hop receipt
(each hop a def-use step with file:line or a call binding, container-level hops labeled as
such), or `no-flow-within-analyzed-scope` with the bounding frontier enumerated (unresolved or
external callees, dynamic-dispatch sites, unsupported-language regions, and any depth cap hit).
The response SHALL state the sound direction verbatim — a found flow is proven, an absent flow
is bounded by the disclosed frontier — and SHALL never use the word "safe". The tool SHALL be a
`conclusion` in family `navigate`, available only in the `full` preset, cross-referencing
`trace_execution_path` (control flow) and `analyze_error_propagation` (exception flow) as its
adjacent siblings.

#### Scenario: A found flow carries a replayable path

- **GIVEN** a value passed from `handleRequest`'s parameter through `buildQuery` into a query
  string
- **WHEN** `trace_data_flow` runs with that source and sink
- **THEN** the verdict is `flow-found` with ordered hops naming each def-use line and each call
  binding, so the path can be verified by reading the cited lines

#### Scenario: Absence is bounded, never blessed

- **GIVEN** a source whose reachable region includes an unresolved dynamic-dispatch site and an
  external callee
- **WHEN** no flow to the sink is found
- **THEN** the verdict is `no-flow-within-analyzed-scope` with both frontier items enumerated
  and the sound-direction statement present — the response never claims safety
