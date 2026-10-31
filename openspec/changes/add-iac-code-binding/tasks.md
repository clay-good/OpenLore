# Tasks — add-iac-code-binding

## Implementation
- [ ] Handler/command capture: Terraform `aws_lambda_function.handler`, CFN/SAM `Handler`, Serverless
      `functions.*.handler`, Dockerfile `CMD`/`ENTRYPOINT`, Kubernetes container `command`/`args`
- [ ] Literal resolver: `file.export` convention; script path → module entry; build-output path only
      via tsconfig `outDir`/package `main` mapping; else disclosed unresolved
- [ ] `deploys_symbol` edge (resource → function); bound function treated as an entry point by
      `find_dead_code`
- [ ] Env declaration capture (key, ecosystem, resource address, file, line, literal-present flag;
      never the value): Kubernetes `env`, compose `environment`, Dockerfile `ENV`, Terraform/CFN
      Lambda environment maps, GitHub Actions `env`
- [ ] `analyze_env_impact`: `declaredBy[]`, `undeclared-in-corpus`; `blast_radius`: IaC sites still
      setting a key the diff renamed or removed in code
- [ ] Language-support capability `iacCodeBinding` derived from the extractors

## Verification
- [ ] Lambda handler string binds to the exported function; renaming it surfaces the resource in
      `analyze_impact`; `find_dead_code` keeps it live
- [ ] `${var.handler}` → disclosed unresolved, not dropped
- [ ] `DATABASE_URL` set in a K8s Deployment and a compose file → both in `declaredBy`; no value stored
- [ ] A code rename of an env key → `blast_radius` lists the manifests that still set the old key
- [ ] Full suite green

## Spec
- [ ] `analyzer` delta: ADD IacResourcesBindToTheCodeTheyRun
- [ ] `mcp-handlers` delta: ADD EnvImpactNamesIacDeclarationSites
