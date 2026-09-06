# config spec delta

## ADDED Requirements

### Requirement: AutoInitOptOutKey

`.openlore/config.json` SHALL support an optional `autoInit: boolean` key (default `true`).
When `false`, no background auto-initialization (cold-start bootstrap or any successor
background repair trigger) runs for that repository; explicit commands (`openlore analyze`,
`openlore install`) are unaffected. The key SHALL be listed by the feature inventory
(`openlore features`) with its active state and the snippet to change it, and SHALL remain
optional — zero required config keys is preserved.

#### Scenario: Opt-out is respected and visible

- **GIVEN** `autoInit: false` in a repo's `.openlore/config.json`
- **WHEN** the user runs `openlore features`
- **THEN** auto-init is listed as disabled for this repo with the snippet to re-enable it,
  and no background build has run
