# mcp-handlers spec delta

## ADDED Requirements

### Requirement: StyleFingerprintConclusionTool

The system SHALL expose the style fingerprint through an opt-in MCP tool (`get_style_fingerprint`)
that returns the **computed idiom profile as a conclusion**, never a graph or a source dump. The tool
SHALL return the repository profile by default, the profile for a named community/region on request,
or a single file's profile on request. Each idiom in the result SHALL be reported either as
`{ dominant, ratio, samples }` or, when below the evidence floor or for a compiler-enforced choice, as
a null signal — so a consumer can always distinguish a measured idiom from an absent one. The tool
SHALL declare a complete input schema and SHALL return structured output (the labeled profile object,
classified `conclusion`) per the MCP quality requirements — consistent with the repo's tool
convention, which declares input schemas and returns structured conclusions rather than a separate
`outputSchema` field. It SHALL NOT enter `MINIMAL_TOOLS` or the first-run default surface; it lands
only in an opt-in preset.

#### Scenario: The tool returns a labeled profile, not a graph

- **GIVEN** an analyzed repository
- **WHEN** an agent calls `get_style_fingerprint`
- **THEN** it receives the per-language idiom profile with dominant idioms, ratios, and sample sizes
  (and null signals where evidence is insufficient or the choice is enforced), and receives no
  node-and-edge structure to traverse

#### Scenario: A region profile is available without re-analysis

- **GIVEN** a repository whose map already partitions code into communities
- **WHEN** an agent requests the fingerprint for one community
- **THEN** the tool returns that community's idiom profile from the already-computed fingerprint

### Requirement: OrientSurfacesDominantIdiomsForTouchedRegion

When the evidence is strong enough to pass the fingerprint's evidence floor, `orient` MAY include a
compact summary of the dominant idioms for the region an agent is about to edit, so that an agent
which never calls `get_style_fingerprint` still receives the local house style for the area in scope.
This summary SHALL be drawn from the same computed fingerprint, SHALL obey the same evidence floor and
enforcement-awareness rules (omitting any idiom below the floor or enforced by the compiler), and SHALL
remain a small, bounded addition to the orient payload rather than the full profile.

#### Scenario: Orient carries the local idioms for the area in scope

- **GIVEN** an `orient` call whose resolved region has a strongly-evidenced idiom profile
- **WHEN** the orient result is assembled
- **THEN** it includes a compact summary of that region's dominant idioms, each above the evidence
  floor, so the agent can match the local style without a second tool call

#### Scenario: Orient omits idioms it cannot honestly assert

- **GIVEN** an `orient` call whose resolved region has only thin evidence for an idiom, or whose idiom
  is compiler-enforced
- **WHEN** the orient result is assembled
- **THEN** that idiom is omitted from the summary rather than reported with a misleading or tautological
  ratio
