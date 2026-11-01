# IaC deploy binding, part 2: commands, Serverless, build output, orient

> Status: PROPOSED (2026-11-01). Split from `add-iac-deploy-binding`, whose Lambda handler binding
> (Terraform, CloudFormation/SAM) shipped.

## What changes

| Part | What it does |
|------|--------------|
| Commands | Dockerfile `CMD`/`ENTRYPOINT`, Kubernetes `command`/`args` naming a script bind to its module entry |
| Serverless | a `serverless.yml` reader; `functions.*.handler` binds like a Lambda handler |
| Build output | `dist/…` handlers and commands map to source through `tsconfig` `outDir`/`rootDir` or package `main` |
| `orient` | for a function in scope: the resources bound to it and the sites that set the env vars it reads; budgeted |
| Capability | language-support `iacCodeBinding`, derived from the extractors |

## Impact

- Specs: `analyzer` — 1 ADDED; `mcp-handlers` — 1 ADDED.
