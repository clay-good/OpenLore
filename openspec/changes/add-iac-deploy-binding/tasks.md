# Tasks — add-iac-deploy-binding

- [ ] Handler/command capture: Terraform `aws_lambda_function.handler`, CFN/SAM `Handler`, Serverless `functions.*.handler`, Dockerfile `CMD`/`ENTRYPOINT`, Kubernetes `command`/`args`
- [ ] Literal resolver (`file.export`; script path → module entry; build output via `outDir`/`main`; else disclosed unresolved)
- [ ] `deploys_symbol` edge label; bound function is a `find_dead_code` entry point
- [ ] `orient` additive field (bound resources + env declaration sites of vars read), budgeted
- [ ] Language-support capability `iacCodeBinding`
- [ ] Tests: Lambda handler binds and survives dead-code; `var.handler` disclosed; orient on a handler
- [ ] Spec: `analyzer` ADD IacResourcesBindToTheCodeTheyRun; `mcp-handlers` ADD OrientShowsTheInfrastructureAHandlerDependsOn
