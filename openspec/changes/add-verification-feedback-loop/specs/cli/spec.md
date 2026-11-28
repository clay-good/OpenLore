# cli spec delta

## ADDED Requirements

### Requirement: StopHandsBackNewFindingsOnce

At the before-stop moment, when the `verify_change` receipt has open items that were not handed
back to the agent before in the session, `openlore hook before-stop` SHALL hand them back once as
the reason of a Claude Code `block` decision, each with its proof and one action. It SHALL NOT block
when `stop_hook_active` is true, and SHALL NOT hand back the same item set twice.

#### Scenario: A new break is handed back

- **GIVEN** a session diff that removes an export a function in another file still calls
- **WHEN** the agent stops for the first time
- **THEN** the hook returns `decision: "block"` with the item, its file and line, and its action

#### Scenario: No loop

- **GIVEN** the payload has `stop_hook_active: true`
- **WHEN** the hook runs
- **THEN** it does not block

#### Scenario: Nothing new

- **GIVEN** every open item was handed back earlier in the session
- **WHEN** the agent stops again
- **THEN** nothing is handed back to the agent

#### Scenario: An item that needs a human

- **GIVEN** an open item that changes a contract with consumers outside the repository
- **WHEN** it is handed back
- **THEN** its action is to raise it to a human in the final message or pull-request body
