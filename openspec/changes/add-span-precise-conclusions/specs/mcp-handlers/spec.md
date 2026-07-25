# mcp-handlers spec delta

## ADDED Requirements

### Requirement: ConclusionsCarrySpanEvidence

Symbol-level conclusion entries SHALL carry the span evidence the graph already stores:
`search_code` symbol hits and `orient` function entries SHALL include the symbol's start line,
and `analyze_impact` affected entries and `trace_execution_path` steps SHALL include the
call-site line of the edge that placed them in the answer. Surfaced lines SHALL come from stored
structural facts only — never inferred or approximated — and stale-index line freshness SHALL be
disclosed using the established dual-baseline verdict rather than presented as current.

#### Scenario: A trace names the exact call sites

- **GIVEN** a `trace_execution_path` result from A to C via B
- **WHEN** the path is returned
- **THEN** each step carries the line of the call site that creates the edge, equal to the
  `line` stored on that edge at extraction

#### Scenario: Lines are facts, not guesses

- **GIVEN** an edge whose call-site line was not captured at extraction
- **WHEN** its step is returned
- **THEN** the line field is absent — never estimated from the callee's span or any other
  heuristic

### Requirement: SliceFocusDisclosesPrecisionAndScope

`get_function_body` SHALL accept an optional `focus` (a variable or callee name within the
symbol). With focus, the response SHALL be the def-use / call-site slice for that focus — the
relevant lines with minimal excerpt — with each line tagged by its stored precision
(`exact | may`); `may` SHALL never be collapsed into or presented as `exact`. For a language
without CFG-overlay support, or a focus that does not appear in the function, the tool SHALL
return the whole span (or a not-found) with an explicit machine-readable reason — a slice is
never silently unavailable. Without `focus`, the response SHALL be unchanged from today.

#### Scenario: A focused read costs the slice, not the body

- **GIVEN** a 300-line function and `focus` on a variable used in 6 lines
- **WHEN** `get_function_body` runs with that focus
- **THEN** the response contains those def/use lines with their `exact | may` tags and minimal
  excerpt, not the full body

#### Scenario: An unsupported language degrades honestly

- **GIVEN** a focus request on a symbol in a language outside the CFG overlay's supported set
- **WHEN** the tool responds
- **THEN** it returns the whole span plus an explicit `sliceUnavailable` reason naming the
  language boundary — never a partial slice and never a silent full body that implies slicing
  was applied
