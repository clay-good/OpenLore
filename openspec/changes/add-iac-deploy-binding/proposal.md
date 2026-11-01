# IaC deploy binding: which code a resource runs

> Status: PROPOSED (2026-11-01). Split from `add-iac-code-binding`, whose env-declaration half
> shipped (`declaredBy` in `analyze_env_impact`, `envDeclarations` in `blast_radius`, OpenTofu).

## Why

A Lambda's `handler = "src/orders.handler"`, a SAM or Serverless `handler:`, a Dockerfile
`CMD`/`ENTRYPOINT`, or a Kubernetes `command` names the code a resource runs. Today renaming that
function shows no infrastructure impact, and `find_dead_code` can call a deployed entry point dead.

## What changes

| Part | What it does |
|------|--------------|
| `deploys_symbol` edge | resource → function, when the handler or command names it literally (`file.export`; a script path binds to its module entry; a build-output path only through `outDir` / package `main`) |
| Dead code | a bound function is an entry point |
| Impact | `analyze_impact` / `blast_radius` reach the resource from the function |
| `orient` | for a function in scope: the resources bound to it and the sites that set the env vars it reads; budgeted |
| Capability | language-support `iacCodeBinding`, derived from the extractors |

An interpolated handler (`var.handler`, a Helm value) is a disclosed unresolved binding, never
dropped.

## Not built

Live cloud state, `terraform plan`, Helm rendering.

## Impact

- Specs: `analyzer` — 1 ADDED; `mcp-handlers` — 1 ADDED.
