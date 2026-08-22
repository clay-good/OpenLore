# mcp-handlers spec delta

## ADDED Requirements

### Requirement: ConclusionsCarrySpanEvidence

Symbol-level conclusion entries SHALL carry the span evidence the graph already stores:
`search_code` symbol hits and `orient` function entries SHALL include the symbol's start line,
joined by canonical symbol id. `analyze_impact` SHALL select affected entries by canonical order
within a global response cap and include a `callSites` collection containing every stored
call-site line on qualifying shortest-frontier edges that place each selected entry at its
reported depth. A top-level `callSiteEvidenceReceipt` SHALL disclose the eligible, returned, and
omitted entry counts and whether the global cap truncated evidence. Every non-terminal `trace_execution_path` step SHALL
include a `callsNext` collection containing every stored call-site line on parallel edges from
that step's symbol to the next symbol. Each receipt SHALL identify its caller so distinct
same-file, same-line edges remain distinguishable. These collections SHALL be deterministically ordered,
SHALL deduplicate identical receipts, and SHALL be response- and computation-bounded. The receipt
SHALL expose `returned`, exact `total` when complete or bounded `totalAtLeast` when truncated,
and `truncated`; it MUST NOT retain unbounded uniqueness state merely to compute an exact total. Surfaced lines SHALL come
from stored structural facts only — never inferred or approximated. A missing stored line SHALL
remain absent, and stale-index line freshness SHALL be disclosed using the established
content-hash-first, artifact-mtime-fallback dual-baseline verdict rather than presented as current.

#### Scenario: A trace names the exact call sites

- **GIVEN** a `trace_execution_path` result from A to C via B and two stored parallel A→B call
  edges at distinct lines
- **WHEN** the path is returned
- **THEN** A's `callsNext` contains both stored lines in deterministic order, B's `callsNext`
  contains every stored B→C line, and C has no `callsNext`

#### Scenario: Impact preserves every shortest-frontier receipt

- **GIVEN** an affected symbol within the global evidence cap is reached at the same shortest depth from two prior-depth callers
- **WHEN** `analyze_impact` returns that affected entry
- **THEN** its `callSites` contains every stored qualifying edge receipt from both callers rather
  than one arbitrarily selected line

#### Scenario: Lines are facts, not guesses

- **GIVEN** an edge whose call-site line was not captured at extraction
- **WHEN** its step is returned
- **THEN** no receipt is fabricated for that edge — the line is never estimated from the
  callee's span or any other heuristic

### Requirement: SliceFocusDisclosesPrecisionAndScope

`get_function_body` SHALL accept optional focused reads using `focus` plus an explicit
`focusKind: variable | callee`. A successful focused response SHALL omit the full `body` and
SHALL return bounded, deterministically ordered stored line receipts with source text and an
explicit completeness/truncation receipt. A `variable` focus SHALL return persisted direct
definition/use evidence for the same display spelling within the selected function, with roles
and the stored `dataFlowPrecision: exact | may`; the response SHALL disclose that variable
spellings are not scope-qualified, and `may` SHALL never be collapsed into `exact`. A `callee`
focus SHALL return every stored parallel call-site receipt whose raw callee name matches, with
the edge's stored `callConfidence`; it SHALL NOT fabricate a data-flow precision label for call
evidence. Calls that omit `focus` and `focusKind` SHALL preserve the legacy response byte-for-byte.

A variable focus outside CFG-overlay language support or without a usable overlay SHALL return
the legacy whole body with a machine-readable `sliceUnavailable` reason. An unknown focus SHALL
return a typed not-found result with bounded candidates. An ambiguous symbol, stale or mixed
analysis generation, unreadable source, or stored line outside the selected symbol span SHALL
fail closed with a machine-readable refusal and no focused body. Symbol resolution, freshness,
and line evidence SHALL come from one cached analysis generation.

#### Scenario: A focused read costs the slice, not the body

- **GIVEN** a 300-line function and `focusKind: variable` for a spelling with 6 persisted direct
  definition/use evidence lines
- **WHEN** `get_function_body` runs with that focus
- **THEN** the response contains those 6 lines with their source text, roles, and unchanged
  `dataFlowPrecision` values, an explicit completeness receipt, and no `body`

#### Scenario: Callee focus does not invent data-flow precision

- **GIVEN** a function with two stored call edges whose raw callee name matches the requested
  `focusKind: callee`
- **WHEN** `get_function_body` runs with that focus
- **THEN** both line receipts carry their stored `callConfidence`, neither carries
  `dataFlowPrecision`, and the response contains no full `body`

#### Scenario: An unsupported language degrades honestly

- **GIVEN** a variable-focus request on a symbol in a language outside the CFG overlay's
  supported set
- **WHEN** the tool responds
- **THEN** it returns the whole span plus an explicit `sliceUnavailable` reason naming the
  language boundary — never a partial slice and never a silent full body that implies slicing
  was applied

#### Scenario: Stale focused coordinates fail closed

- **GIVEN** the selected source file no longer matches the cached generation's content hash or
  artifact-mtime fallback
- **WHEN** a focused read is requested
- **THEN** the tool returns a machine-readable stale refusal with no slice and no body derived
  from the stale indexed span

#### Scenario: Legacy full-body calls do not change

- **GIVEN** a caller omits both `focus` and `focusKind`
- **WHEN** `get_function_body` runs through the indexed or line-scan path
- **THEN** its response is byte-for-byte identical to the response before focused reads existed
