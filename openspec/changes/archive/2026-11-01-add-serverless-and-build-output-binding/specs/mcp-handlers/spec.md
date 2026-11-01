# mcp-handlers spec delta

## ADDED Requirements

### Requirement: OrientShowsTheInfrastructureAHandlerDependsOn

`orient` SHALL list, as one budgeted additive field, the resources bound to a function in its scope
by a `deploys_symbol` edge and the environment variables those functions read with the
infrastructure sites that set them. A variable no site the scan read sets SHALL be named as
undeclared rather than omitted, with what the scan could not read disclosed beside it, so
`undeclared` is never an absolute claim. The infrastructure scan SHALL run only when a function in scope
reads a variable, so a task that touches no handler pays nothing for the field.

#### Scenario: orient on a Lambda handler names its resource and manifests

- **GIVEN** a Lambda resource whose handler binds to `handler` in `src/orders.ts`, which reads
  `TABLE_NAME`, set in the same Terraform resource
- **WHEN** `orient` runs on a task about `handler`
- **THEN** the briefing names `aws_lambda_function.orders` and the Terraform site that sets
  `TABLE_NAME`

#### Scenario: A variable the repository does not set

- **GIVEN** the same handler, which also reads `AWS_REGION`, which no indexed manifest sets
- **WHEN** `orient` runs
- **THEN** `AWS_REGION` is named as undeclared
