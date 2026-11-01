# mcp-handlers spec delta

## ADDED Requirements

### Requirement: OrientShowsTheInfrastructureAHandlerDependsOn

`orient` SHALL list, for a function in its scope, the env vars it reads with the infrastructure sites
that set them, and the resources bound to it by a `deploys_symbol` edge, as one budgeted additive
field.

#### Scenario: orient on a Lambda handler names its resource and manifests

- **GIVEN** a Lambda resource whose handler binds to `handler` in `src/orders.ts`, which reads
  `TABLE_NAME`, set in the same Terraform resource
- **WHEN** `orient` runs on a task about `handler`
- **THEN** the briefing names `aws_lambda_function.orders` and the Terraform site that sets
  `TABLE_NAME`
