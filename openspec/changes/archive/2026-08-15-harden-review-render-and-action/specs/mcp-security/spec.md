# mcp-security spec delta

## ADDED Requirements

### Requirement: ReviewActionWriteTokenTrustBoundary

The bundled review Action's shipped guidance SHALL state its trust boundary honestly: analyzing a
pull request requires checking out and parsing head-controlled content, so any configuration that
pairs that analysis with a write-capable token (notably `pull_request_target` with a head
checkout) is a real elevation, not a safe default. The example workflow SHALL warn against
`pull_request_target` with a head checkout, SHALL document the two-workflow `workflow_run`
pattern (untrusted analysis under a read-only token; comment posting in a separate trusted job)
as the recommended way to comment on fork PRs. Whenever a write token is in scope, the example
SHALL require synchronized, reviewed, immutable Action and package-version pins. Before a release
containing this hardening exists, mandatory placeholders SHALL keep the copied example
non-runnable and the Action SHALL reject an unresolved package placeholder. Guidance SHALL never
claim the Action "runs no untrusted code" as a justification for elevated triggers.

#### Scenario: The example workflow no longer blesses pull_request_target

- **GIVEN** a maintainer reading the shipped workflow example to enable fork-PR comments
- **WHEN** they reach the fork-PR guidance
- **THEN** it warns that `pull_request_target` plus a head checkout runs attacker-influenced
  analysis with a write token, and points to the `workflow_run` split as the safe alternative

#### Scenario: Pinning is recommended where the token can write

- **GIVEN** a workflow granting `pull-requests: write`
- **WHEN** the maintainer follows the shipped guidance
- **THEN** it requires the maintainer to replace synchronized fail-closed placeholders with a
  reviewed immutable Action commit and a package release that contains the same hardening
