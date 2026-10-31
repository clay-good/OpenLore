# IaC ↔ code binding: which code a resource runs, and which resource sets each env var

> Status: PROPOSED (2026-10-31, `CONTRACT-GRAPH-AND-AGENT-LOOP-2026-10.md`). Two literal joins
> between the shipped IaC graph and the shipped code graph. No new tool.

## The gap

The IaC projector (`docs/iac.md`) builds a resource graph for 12 ecosystems, and the code graph
knows every function and every env-var read (`analyze_env_impact`). The two only meet where code
*embeds* IaC (Pulumi/CDK resources inside a function, `docs/cross-domain-impact.md`). Two common
bindings are missing:

1. **What code does this resource run?** A Lambda's `handler = "src/orders.handler"`, a SAM/CFN
   `Handler:`, a Serverless `handler:`, a Dockerfile `CMD`/`ENTRYPOINT` or a Kubernetes container
   `command` naming a source file. Today, renaming `handler` in `src/orders.ts` shows no infra
   impact, and `find_dead_code` can call a deployed entry point dead.
2. **Which resource sets this env var?** `analyze_env_impact` reports `declaredInEnvFile` (a `.env`
   default) but not that a Kubernetes `env:` entry, a compose `environment:` key, a Dockerfile
   `ENV`, a Terraform/CFN Lambda `environment.variables` map, or a GitHub Actions `env:` sets it.
   An agent that renames `DATABASE_URL` in code cannot see the three manifests that still set the old
   name.

## What changes

- **Deploy-target edges.** A resource whose handler or command names a source file and symbol
  literally gets an edge (resource → function) with a new `deploys_symbol` call-type label, beside the
  existing `http_endpoint` label — a small edge-schema addition. Resolution is literal: the module path
  is resolved against the analyzed corpus with the ecosystem's own convention (`file.export` for
  Lambda/SAM/Serverless; a script path in `CMD`/`ENTRYPOINT`/`command` binds to that file's
  module-level entry). A build-output path (`dist/server.js`) binds only when the analyzed tsconfig or
  package `main` maps it back to a source file; otherwise it is a disclosed unresolved binding.
  The bound function is an entry point for `find_dead_code` and reaches the resource for
  `analyze_impact` / `blast_radius`.
- **Env declaration sites.** The IaC extractors gain env-key parsing (new work: none of them reads
  env keys today) and record each key as a declaration site `{ name, ecosystem, resource address, file, line, literal value present? }`.
  `analyze_env_impact` gains `declaredBy[]` (the IaC sites), and a read with no declaration anywhere
  in the corpus is listed as `undeclared-in-corpus` (informational: production may inject it).
  `blast_radius` on a diff that changes an env key in code lists the IaC sites that still set the
  old key.
- **Secrets stay out.** Only the key, the location, and whether a literal value is present are
  recorded — never the value.

## Honesty contract

An interpolated handler or key (`${var.handler}`, Helm `{{ .Values.x }}`) is a disclosed unresolved
binding, not a missing one. `undeclared-in-corpus` is never phrased as "unset": OpenLore cannot see
runtime injection, secret stores, or CI variables defined outside the repo.

## Not built

Reading `terraform.tfstate` or any live cloud state (it holds secrets and is not static); rendering
Helm or running `terraform plan`; mapping env vars to config-object keys (already a disclosed
boundary of `analyze_env_impact`).

## Impact

- Files: handler/command readers in the Terraform, CloudFormation/SAM, Serverless (new small reader),
  Docker, Kubernetes extractors; env-key capture in Kubernetes, Docker/compose, Terraform,
  CloudFormation, GitHub Actions; resolver against the corpus; `env-impact.ts` field; `blast_radius`
  additive field; language-support capability `iacCodeBinding`.
- Specs: `analyzer` — 1 ADDED; `mcp-handlers` — 1 ADDED.
- Tool surface: none added.
