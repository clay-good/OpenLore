# analyzer spec delta

## ADDED Requirements

### Requirement: HtmlAssetDependencyEdges

The dependency graph SHALL create file→file edges from an `.html`/`.htm` file to the local assets it
references inline: `<script src=…>` and `<link rel="stylesheet" href=…>`. References to absolute URLs
(`http://`, `https://`, protocol-relative `//`), `data:` URIs, `mailto:`, and `#` fragment anchors SHALL
NOT produce edges. A referenced asset SHALL produce an edge only when it resolves to a file already
present as a node in the graph. HTML files referencing no resolvable local asset SHALL produce no edges
and SHALL NOT error. Non-HTML dependency-graph output SHALL be unchanged.

#### Scenario: A page links to its script and stylesheet

- **GIVEN** an `index.html` containing `<script src="app.js">` and `<link rel="stylesheet" href="style.css">`,
  with `app.js` and `style.css` present in the repository
- **WHEN** the dependency graph is built
- **THEN** it contains an edge `index.html → app.js` and an edge `index.html → style.css`, and the
  in-degree of `style.css` includes `index.html`

#### Scenario: External and non-stylesheet references are excluded

- **GIVEN** an HTML page whose references are a CDN `<script src="https://cdn.example/app.js">` and a
  `<link rel="preload" href="font.woff2">`
- **WHEN** the dependency graph is built
- **THEN** neither produces an edge, and the page contributes no out-edges

#### Scenario: Non-HTML dependency edges are unaffected

- **GIVEN** a project with no HTML files
- **WHEN** the dependency graph is built with HTML asset extraction enabled
- **THEN** the resulting edges are identical to the output without the feature
