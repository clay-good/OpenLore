# cli spec delta

## ADDED Requirements

### Requirement: ViewerDisclosesAnalysisStaleness

The viewer SHALL disclose the freshness of the analysis it renders: each served artifact
SHALL carry its generated-at time (and the analyzed commit versus current HEAD where
recorded), and the UI SHALL surface a dismissible staleness indicator when the artifact
predates the latest commit touching analyzed files — consistent with the freshness discipline
every other OpenLore surface carries.

#### Scenario: A stale graph is not shown as current

- **GIVEN** an analysis artifact older than the current working tree
- **WHEN** the user opens `openlore view`
- **THEN** the UI shows a staleness indicator rather than presenting the old graph as current
