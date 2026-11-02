# mcp-handlers spec delta

## ADDED Requirements

### Requirement: OrientShowsTheInfrastructureAHandlerDependsOn

`orient` SHALL list, as one budgeted additive field, each resource bound to a function in its scope
by a `deploys_symbol` edge and, for those deployed functions, the environment variables they read
with the infrastructure sites that set them. A variable no site the scan read sets SHALL be named
as undeclared rather than omitted, and whatever the scan or the read pass could not cover SHALL be
disclosed beside it, so `undeclared` is never an absolute claim. Nothing SHALL be read for the
field when no resource runs a function in scope, so a task that touches no deployed handler pays
only one pass over the edge list.

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

#### Scenario: A task that touches no deployed handler

- **GIVEN** a scope whose functions read environment variables and that no resource deploys
- **WHEN** `orient` runs
- **THEN** the field is absent, and neither the scope's files nor the infrastructure manifests are
  read for it
