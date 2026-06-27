# analyzer spec delta

## ADDED Requirements

### Requirement: InlineScriptCallGraphExtraction

The system SHALL extract JavaScript defined in inline `<script>` blocks of `.html`/`.htm` files into the
call graph as ordinary JavaScript function nodes whose `filePath` is the HTML file. Extraction SHALL use
offset-preserving blanking: the JavaScript extractor SHALL be given a string of the same length as the
HTML in which every character outside an inline `<script>` body is replaced by a space and newlines are
preserved, so that node start/end offsets and line numbers map to the HTML file. Only inline scripts of
type `text/javascript`, `module`, or with no `type` SHALL be extracted; `application/json`, `importmap`,
and external (`src=`) scripts SHALL be excluded. A file with no qualifying inline script SHALL
contribute no nodes and SHALL NOT error.

#### Scenario: An inline-script function becomes a call-graph node

- **GIVEN** an `index.html` whose inline `<script>` defines `function foo() { bar(); }` and `function bar() {}`
- **WHEN** the call graph is built
- **THEN** the graph contains nodes for `foo` and `bar` with `filePath` equal to `index.html`, a
  `foo → bar` call edge, and 1-based line numbers matching the script's position in the file

#### Scenario: Non-JavaScript and external scripts are excluded

- **GIVEN** an HTML file containing a `<script type="application/json">` block and a `<script src="app.js">` tag
- **WHEN** the call graph is built
- **THEN** neither contributes nodes, and a file with no inline JavaScript contributes none

#### Scenario: Non-HTML extraction is unaffected

- **GIVEN** a project with no HTML files
- **WHEN** the call graph is built with inline-script extraction enabled
- **THEN** the resulting nodes and edges are identical to the output without the feature
