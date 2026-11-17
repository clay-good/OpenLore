# IaC env declarations: which infrastructure sets each env var

> Status: SHIPPED (2026-11-01, `CONTRACT-GRAPH-AND-AGENT-LOOP-2026-10.md`). The deploy-target half
> (resource → handler function, dead-code entry points, `orient`) moved to `add-iac-deploy-binding`.

## Why

`analyze_env_impact` reported only `.env` defaults. An agent renaming `DATABASE_URL` in code could
not see the Kubernetes Deployment, compose file, Dockerfile, Terraform resource, or workflow that
still set the old name.

## What changes

| Surface | New |
|---------|-----|
| `analyze_env_impact` | `declaredBy` (ecosystem, resource, file, line, literal value present — never the value); `declaration: undeclared-in-corpus` when no file sets it; `opaqueEnvSources` for `envFrom`, `env_file`, expression maps |
| `blast_radius` | `envDeclarations`: env vars the diff stops reading anywhere, each with the sites that still set it |
| Language detection | `.tofu` and `.tofu.json` are Terraform |

Ecosystems: Kubernetes, Docker Compose, Dockerfile, Terraform/OpenTofu (HCL and JSON),
CloudFormation/SAM (incl. ECS), GitHub Actions. Scanned at query time; Helm templates are skipped
and disclosed.

## Not built

Values (never read into output), live cloud state, Helm rendering, config-object keys.
