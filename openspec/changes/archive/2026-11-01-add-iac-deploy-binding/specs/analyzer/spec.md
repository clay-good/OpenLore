# analyzer spec delta

## ADDED Requirements

### Requirement: IacResourcesBindToTheCodeTheyRun

The IaC projection SHALL link a resource to the indexed function it runs, by a `deploys_symbol`
edge, when the resource's handler names a source location literally: a Terraform
`aws_lambda_function` or CloudFormation/SAM function handler in `<module>.<export>` form, resolved
relative to its code location, the repository root, or the template's directory. An interpolated or otherwise non-literal handler SHALL be
recorded as a disclosed unresolved binding, never dropped silently. A bound function SHALL count as
an entry point for dead-code analysis.

#### Scenario: A Lambda handler binds to its function

- **GIVEN** a Terraform `aws_lambda_function` with `handler = "src/orders.handler"` and an exported
  `handler` function in `src/orders.ts`
- **WHEN** the repository is analyzed
- **THEN** a `deploys_symbol` edge links the resource to the function, and `find_dead_code` does not
  list the function

#### Scenario: An interpolated handler is disclosed

- **GIVEN** a Lambda resource with `handler = var.handler`
- **WHEN** the repository is analyzed
- **THEN** no edge is created and the resource is listed as an unresolved binding with the reason
