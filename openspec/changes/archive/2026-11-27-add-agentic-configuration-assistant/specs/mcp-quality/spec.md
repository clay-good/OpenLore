# Agent integration specification delta

## ADDED Requirements

### Requirement: ConfigurationAssistantIsAvailableThroughTheExistingHost

The existing agent host SHALL provide a configuration-assistant workflow using shared local evidence
and operations rather than a second OpenLore-owned LLM conversation. Pi and RPC hosts SHALL support
an extension-only installation without a mandatory terminal or globally installed executable.
Existing configure-wizard invocations SHALL remain compatible.

#### Scenario: A Pi extension is the only installation
- **GIVEN** OpenLore is installed as a Pi package and no global CLI is on PATH
- **WHEN** the user invokes the assistant from Pi or an RPC host such as pi-outpost
- **THEN** inspection, preview and authorized recovery are available through the installed package

#### Scenario: An existing configure invocation is used
- **GIVEN** a user invoking the existing bare configure command or wizard tool
- **WHEN** the assistant feature is added
- **THEN** the existing invocation retains its behavior rather than silently starting the new workflow

#### Scenario: A host cannot display an interactive dialog
- **GIVEN** a host that supports structured tool results but no interactive selection UI
- **WHEN** the assistant needs a user decision or additional authority
- **THEN** it returns a structured pending action or plan without hanging on a UI response

### Requirement: ConfigurationAdaptersShareEvidenceAndAuthoritySemantics

Pi, optional CLI and opt-in MCP adapters SHALL use the same inspection, policy, planning,
publication, verification and rollback contracts. Each mutating action SHALL enforce trusted host
authorization; an action string or plan received over the transport SHALL not grant that authority.
An operational inspection SHALL NOT require or trigger structural index bootstrap first.

#### Scenario: An MCP inspection sees a missing index
- **GIVEN** an explicitly enabled configuration-management tool and no index
- **WHEN** its inspect action is called
- **THEN** it returns missing-index evidence without waiting for automatic analysis

#### Scenario: Adapters receive the same stale plan
- **GIVEN** equivalent host authority and a stale configuration plan
- **WHEN** the plan is submitted through Pi, CLI or the enabled MCP management adapter
- **THEN** each refuses publication with the same stale-plan meaning and unchanged project state

### Requirement: ConfigurationAssistanceDoesNotInflateTheDefaultToolSurface

The MCP configuration-management tool SHALL be opt-in and SHALL NOT be added to existing default
structural presets by this change. It SHALL declare the applicable existing family, a conclusion
output class and conservative mutation annotations, with incomplete evidence registered in the
shared disclosure mechanism. Read-only action names SHALL not cause the whole management tool to
be advertised as read-only when other actions mutate persistent or runtime state.

#### Scenario: A normal structural session does not use configuration assistance
- **GIVEN** an unchanged default MCP installation
- **WHEN** its tool list is requested after this feature ships
- **THEN** the management tool and assistant instructions do not add standing context to that session

#### Scenario: An enabled tool can apply a plan
- **GIVEN** a management tool exposing both inspection and mutation actions
- **WHEN** its annotations are read
- **THEN** they conservatively disclose mutation and individual actions still enforce authorization
