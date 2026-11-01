# analyzer spec delta

## ADDED Requirements

### Requirement: IacResourcesBindToTheCodeTheyRun

The IaC projection SHALL link a resource to the indexed function it runs, by a `deploys_symbol`
edge, when the resource's handler or command names a source location literally: a Lambda, SAM,
CloudFormation, or Serverless handler in `<module>.<export>` form, or a Dockerfile
`CMD`/`ENTRYPOINT` or Kubernetes container `command` naming a script file (bound to that file's
module-level entry). A build-output path SHALL bind only through the analyzed project's own
`outDir` or package `main` mapping. An interpolated or otherwise non-literal handler SHALL be
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
