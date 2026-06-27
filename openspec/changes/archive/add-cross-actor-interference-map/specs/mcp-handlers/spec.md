# mcp-handlers spec delta

## ADDED Requirements

### Requirement: CrossActorInterferenceMap

The system SHALL compute, on demand, a conflict graph over all in-flight changes — local branches,
open pull requests, and caller-supplied agent task descriptors — treating human and agent changes as
nodes of the same kind. For each in-flight change the system SHALL derive a footprint from its actual
changed symbols (a branch diff against its base; a PR's changed files via the existing git/PR
integration; an agent descriptor via its declared seeds) and SHALL classify the pairwise hazards
across all nodes using the shared hazard classifier. The capability SHALL be read-only and stateless:
it SHALL run no watcher, poll, or background process, and SHALL persist no conflict store; it answers
from current git state and the indexed graph at call time. It SHALL be classified as a conclusion tool
and SHALL land in the federation preset, not in the minimal tool set or the lean first-run default.
Every result SHALL carry a disclosure that structural overlap predicts conflict probability, not
certainty, and that merge/integration remains the ground truth.

#### Scenario: Two branches sharing a written symbol conflict

- **GIVEN** two local branches whose diffs against base both modify the same symbol
- **WHEN** the interference map is computed
- **THEN** a write-write conflict is reported between the two branches' actors, naming the shared symbol

#### Scenario: An agent task and a human branch are compared uniformly

- **GIVEN** a caller-supplied agent task descriptor and a local branch whose diff shares a symbol with
  the task's write-set
- **WHEN** the interference map is computed
- **THEN** a cross-actor conflict is reported between the agent task and the branch, of the same hazard
  classes used for agent-to-agent conflicts

#### Scenario: Two PRs appending to the same registry do not falsely conflict

- **GIVEN** two open pull requests that each add a disjoint new entry to the same tool-registry array
  or dispatcher
- **WHEN** the interference map is computed from their actual diffs
- **THEN** the collision is resolved-by-merge and no write-write conflict is reported between them

#### Scenario: A change that cannot be assessed is labeled, not cleared

- **GIVEN** an open pull request whose diff cannot be fetched, or a change whose symbols cannot be
  resolved against the index
- **WHEN** the interference map is computed
- **THEN** that change is labeled "not assessed" rather than reported as having no conflict

### Requirement: CrossActorMapExtendsAcrossFederation

When a federation is configured, the interference map SHALL match footprints across repository
boundaries using federation's stable cross-repo symbol resolution, so that an in-flight change in one
repository conflicts with an in-flight change in another when their footprints intersect across the
boundary. When no federation is configured, the map SHALL degrade cleanly to a single repository
(its branches, local PRs, and supplied descriptors) and SHALL NOT require federation. The map SHALL be
deterministic for a fixed git and index state.

#### Scenario: A branch in one repo conflicts with a PR in another

- **GIVEN** a federation of two indexed repositories where a branch in repository A and an open PR in
  repository B modify the same federated symbol
- **WHEN** the interference map is computed
- **THEN** a cross-repo conflict is reported between the branch in A and the PR in B, naming the shared
  federated symbol

#### Scenario: No federation degrades to single-repo

- **GIVEN** a single repository with no federation configured
- **WHEN** the interference map is computed
- **THEN** it returns the conflict graph over that repository's own branches, local PRs, and supplied
  descriptors, with no federation required
