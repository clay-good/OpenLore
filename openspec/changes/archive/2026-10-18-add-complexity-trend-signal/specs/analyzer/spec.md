# analyzer spec delta

## ADDED Requirements

### Requirement: ComplexityTrendIsDescriptiveAndBounded

`get_health_map` SHALL report a descriptive complexity trend for hotspot functions — at or above the
high-complexity threshold, in a file with recorded churn — by re-parsing each file with the analyze
extractor and complexity estimator at its most recent non-merge commits that are not bulk commits,
bounded per file and per call and disclosed in caveats, attaching the sampled points oldest first.
The label SHALL be `rising` (never decreased, ended higher), `falling` (never increased, ended
lower), `flat` (all equal), or `mixed`, with no score and no threshold on the size of a change, and
SHALL be withheld when fewer than three samples exist. A function that is `rising` and at or above
the threshold in its latest sample SHALL be a `declining-health` finding, advisory by default.
Without churn data the trend SHALL be withheld with the reason, never reported as flat.

#### Scenario: A worsening function is labeled rising; a stable one is not

- **GIVEN** a hotspot function whose complexity climbed over its sampled commits, and another that
  has been stable
- **WHEN** `get_health_map` runs
- **THEN** the first is labeled `rising` with an advisory `declining-health` finding and the second
  `flat`

#### Scenario: Shallow history is withheld, not guessed

- **GIVEN** a hotspot function that exists in fewer than three sampled commits
- **WHEN** the trend is computed
- **THEN** no label is given and the reason is `shallow-history`
