# Spec Delta

## MODIFIED Requirements

### Requirement: PassiveUpdateNotifier

The CLI SHALL passively inform a human when a newer published version is available, without blocking,
and SHALL provide an explicit upgrade command. The version check SHALL be cached and refreshed at most
about once per day, the cached result SHALL be read and printed synchronously while any stale refresh
runs in the background un-awaited, and every network and disk operation SHALL be fail-silent (never
throwing, never breaking a command). The notice SHALL be suppressed in CI, in non-TTY contexts, when
`OPENLORE_NO_UPDATE_NOTIFIER` or `NO_UPDATE_NOTIFIER` is set, and under `--quiet`, and SHALL be shown
only for human-facing commands — never on the hot paths an agent drives (`orient`, `mcp`, `serve`,
hooks). The CLI SHALL NOT update itself automatically. `openlore update` SHALL detect the install
method (Homebrew, global npm, or npx) and run the correct upgrade, with `--check` and `--dry-run`
reporting without changing anything.

The version check SHALL obtain the published version through the package manager itself, with fixed
arguments and no shell, so that the registry, credentials, certificate authority, and proxy declared
in the user's npm configuration decide the transport. A direct registry request SHALL be used only
when the package manager executable cannot be found. The lookup SHALL NOT run in the analyzed
repository, because that repository's package-manager configuration is untrusted input and could
otherwise choose both the registry answering the check and the version it reports. A background
refresh SHALL NOT keep the process alive and SHALL NOT outlive it. The reported version SHALL be read
from every answer shape the package manager and the registry produce, and an answer that carries no
version SHALL be treated as no result rather than as "no update available".

#### Scenario: A human-facing command notes an available update without blocking

- **GIVEN** a cached check showing a newer version and an interactive terminal
- **WHEN** a human-facing command runs
- **THEN** a one-line "update available — run openlore update" notice is printed to stderr instantly from cache
- **AND** the command is not delayed by any network call
- **AND** the notice is absent in CI, non-TTY, opt-out, and `--quiet` contexts, and on agent hot paths

#### Scenario: openlore update upgrades by install method

- **GIVEN** openlore was installed globally via npm (or via Homebrew)
- **WHEN** `openlore update` runs and a newer version exists
- **THEN** it runs `npm install -g openlore@latest` (or `brew upgrade openlore`) respectively
- **AND** for an npx invocation it reports that npx already floats to the latest and changes nothing

#### Scenario: A private registry answers the check

- **GIVEN** a user whose npm configuration points at a private registry with its own credentials
- **WHEN** the version check refreshes
- **THEN** the question goes through the package manager, so that registry answers it
- **AND** no request is made directly to the public registry URL

#### Scenario: The analyzed repository cannot steer the check

- **GIVEN** a repository that ships a package-manager configuration naming another registry
- **WHEN** the version check refreshes while that repository is the working directory
- **THEN** the lookup runs outside the repository, so its configuration is not read

#### Scenario: An answer listing versions is understood

- **GIVEN** a package manager that answers the version query with a list rather than a single value
- **WHEN** the check reads the answer
- **THEN** it reports the highest version in that list, instead of reporting no result
