# Tasks — add-iac-code-binding (env-declaration half)

- [x] Env declaration capture (key, ecosystem, resource, file, line, literal flag; never the value): Kubernetes `env`, compose `environment`, Dockerfile `ENV`, Terraform/OpenTofu HCL + JSON, CloudFormation/SAM + ECS, GitHub Actions `env`
- [x] Opaque sources disclosed: `envFrom`, `env_file`, expression maps; Helm templates skipped and disclosed
- [x] `analyze_env_impact`: `declaredBy`, `declaration` (`undeclared-in-corpus`), `opaqueEnvSources`; CLI text output
- [x] `blast_radius`: `envDeclarations` for reads the diff removed everywhere; CLI text output
- [x] Language detection: `.tofu`, `.tofu.json` → Terraform
- [x] Tests: per-ecosystem parser, no value in output, scan service, rename check, env-impact fields, OpenTofu parity; full suite green
- [x] Moved to `add-iac-deploy-binding`: `deploys_symbol` edges, dead-code entry points, `orient` field, `iacCodeBinding` capability
