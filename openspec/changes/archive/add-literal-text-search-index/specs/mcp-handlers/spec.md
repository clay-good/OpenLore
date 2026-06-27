# mcp-handlers spec delta

## MODIFIED Requirements

### Requirement: handleSearchCode

The `search_code` handler SHALL search the symbol-derived index first. When the symbol search returns
zero results, OR when an explicit `mode: 'text'` is supplied, the handler SHALL query the literal-text
line index and return matching `file:line` results carrying the matched line text. The handler SHALL
remain conclusion-shaped: it returns the computed matches (symbol results or `file:line` text results),
never a graph for the agent to traverse. When symbol results exist and `mode: 'text'` is not set, the
text index SHALL NOT be queried and behavior SHALL be unchanged.

#### Scenario: Literal string found via zero-hit fallback

- **GIVEN** the string `Message completed` exists only as static text in `index.html`
- **WHEN** `search_code` is called with that query and symbol search returns no results
- **THEN** the handler falls back to the literal-text line index and returns the `index.html` location
  with its line number and text

#### Scenario: Forced text mode bypasses symbol search

- **GIVEN** a query for a known literal string
- **WHEN** `search_code` is called with `mode: 'text'`
- **THEN** the handler queries the literal-text line index directly and returns `file:line` matches

#### Scenario: Code search with hits is unchanged

- **GIVEN** a query that matches one or more code symbols
- **WHEN** `search_code` is called without `mode: 'text'`
- **THEN** the handler returns the symbol results and does not query the literal-text line index
