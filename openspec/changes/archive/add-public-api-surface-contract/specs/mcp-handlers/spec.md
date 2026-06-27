# mcp-handlers spec delta

## ADDED Requirements

### Requirement: PublicSurfaceCertificationTool

The system SHALL expose public-surface certification through an opt-in MCP tool
(`certify_public_surface`) and a CLI equivalent that return a **conclusion**, never a graph. Given no
base, the tool SHALL return the current public surface (symbols with signatures). Given a base ref, the
tool SHALL return the breaking-change verdict for the current diff: the classified changes, each
`breaking` change paired with the consumers it breaks, and an overall summary of `breaking`,
`non-breaking`, or `potentially-breaking`. In-repo consumers SHALL be resolved via the call graph;
consumers outside the indexed repo — closed-source/external downstreams, and (until cross-repo federated
resolution lands as a follow-up) sibling federated repos — SHALL be disclosed as a known-unknowable
boundary rather than implied absent.
The tool SHALL declare full input and structured output schemas, reuse the existing
confidence-boundary/staleness disclosure, and SHALL NOT enter the minimal or first-run tool surface.

#### Scenario: A breaking change is certified with its breaking consumers

- **GIVEN** a diff that removes an exported function which three in-repo functions call
- **WHEN** an agent calls `certify_public_surface` with the base ref
- **THEN** the result classifies the change `breaking`, names the three in-repo consumers that break,
  and reports an overall `breaking` summary — as a verdict, not a node-and-edge dump

#### Scenario: External consumers are disclosed, not assumed absent

- **GIVEN** a breaking change to a published package whose downstream consumers are not in any indexed
  repository
- **WHEN** the verdict is produced
- **THEN** it discloses that consumers outside indexed repositories cannot be enumerated (a
  known-unknowable boundary), rather than reporting that the change breaks no one

#### Scenario: A potentially-breaking verdict is never presented as safe

- **GIVEN** a diff whose only public-surface change is `potentially-breaking`
- **WHEN** the verdict is produced
- **THEN** the overall summary is `potentially-breaking` (with the reason), not `non-breaking`
