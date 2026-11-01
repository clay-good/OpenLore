# mcp-handlers spec delta

## ADDED Requirements

### Requirement: DeployedHandlersAreLiveAndDisclosed

`find_dead_code` SHALL treat a function bound by a `deploys_symbol` edge as an entry point
(`rootKinds.deployed`), and SHALL list the function resources whose handler binds to no indexed
function in `unresolvedDeployBindings` with the reason.

#### Scenario: A deployed handler is not dead code

- **GIVEN** a Terraform `aws_lambda_function` with `handler = "src/orders.handler"` and no in-code
  caller of `handler`
- **WHEN** `find_dead_code` runs
- **THEN** `handler` is not a dead-code candidate, and `rootKinds.deployed` counts it
