# cli spec delta

## ADDED Requirements

### Requirement: ReviewMarkdownEscapesHeadControlledText

The `openlore review` Markdown renderer SHALL treat every value originating from the diffed head —
symbol names, signatures, file paths and basenames, rename/drift messages — as untrusted text: it
SHALL neutralize backticks so no value can close its code span, escape HTML-significant
characters, and strip the sticky-comment marker substring from interpolated values, so that no
head-controlled content can inject Markdown structure, mentions, or a second sticky marker into a
comment posted with the repository's token.

#### Scenario: A backtick filename cannot break out of its code span

- **GIVEN** a PR whose head adds a function in a file whose name contains a backtick followed by
  Markdown (a fake section header and an `@mention`)
- **WHEN** `openlore review` renders the briefing
- **THEN** the hostile name renders as inert literal text inside its span; no new Markdown
  section, mention, or formatting appears

#### Scenario: A smuggled sticky marker cannot hijack the comment

- **GIVEN** a head-controlled symbol name containing the literal `<!-- openlore-review -->`
- **WHEN** the briefing is rendered and posted
- **THEN** the marker substring is stripped from the interpolated value, so exactly one sticky
  marker (the renderer's own, on line 1) exists in the comment body

### Requirement: ReviewDisclosesStaleOrFailedAnalysis

When the shared blast-radius confidence boundary reports that graph-relevant source has diverged
from the analysis index, or the CI analyze step failed and a pre-existing index may have been
used, the review briefing SHALL carry an explicit caveat naming the condition. A stale-index
caveat SHALL include the commit at which the index was built. The renderer SHALL use this shared
freshness result rather than introducing a second commit-comparison rule, so a docs-only commit
does not incorrectly make the code graph stale.

#### Scenario: A stale index is named, with its build commit

- **GIVEN** an analysis index built at commit `<sha>` and graph-relevant source divergence reported
  by the shared confidence boundary
- **WHEN** `openlore review` composes the briefing
- **THEN** the caveats include "blast radius reflects a stale index (built at `<sha>`)"

#### Scenario: A swallowed analyze failure surfaces in the briefing

- **GIVEN** the bundled Action's analyze step fails on a PR
- **WHEN** the review step still runs and posts the briefing
- **THEN** the briefing carries a caveat that the index build failed, so the reader knows the
  blast radius may be incomplete or stale

#### Scenario: A configured policy gate attempts to publish its evidence before failing

- **GIVEN** the bundled Action runs `openlore review` with `blastRadius.block` configured
- **WHEN** the CLI returns its reserved policy-gate exit code
- **THEN** the Action attempts to post or update the briefing before propagating the gate failure
- **AND** a comment API failure remains advisory but does not suppress the configured policy gate
- **AND** an unrelated CLI execution error is not classified as a policy finding merely because
  an output file exists
