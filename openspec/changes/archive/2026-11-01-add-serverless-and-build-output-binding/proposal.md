# Serverless handlers, built output, and the infrastructure a handler depends on

> Status: PROPOSED (2026-11-01). Split from `add-iac-deploy-binding-commands`, which keeps the
> container-command half (Dockerfile `CMD`/`ENTRYPOINT`, Kubernetes `command`/`args`) — a command
> names a script, not an export, so what it binds TO needs its own design.

## Why

A Lambda handler binds to the code it runs (`add-iac-deploy-binding`). Two gaps remain for the
same question: a Serverless Framework service declares its functions the same way and was read by
nothing, and a handler that names BUILT output (`dist/orders.handler` — the common case once a
project compiles) bound to nothing at all. And an agent editing a deployed handler still had to
ask three separate tools to learn what runs it and where its configuration comes from.

## What changes

| Part | What it does |
|------|--------------|
| Serverless | a `serverless.yml` reader: each `functions.*` becomes a resource whose handler binds like a Lambda's |
| Build output | a handler under the root `tsconfig.json`'s `outDir` resolves through its `rootDir`, or through a `main`/`source` pair; no `extends` chain is followed, and an unmapped path stays unresolved naming exactly what was read |
| `orient` | when a resource runs a function in scope: that resource, and the sites that set each environment variable the deployed function reads — one budgeted additive field, read only then |
| Capability | language-support `iacCodeBinding`, derived from the extractors that populate a binding |

## Not built

Dockerfile and Kubernetes commands (they stay in `add-iac-deploy-binding-commands`). No plugin
execution, no `${...}` variable resolution, no `sls package`, no build step, no similarity
matching: a handler the project's own declarations do not map is disclosed, never guessed.

## Impact

- Specs: `analyzer` — 2 ADDED; `mcp-handlers` — 1 ADDED.
- New IaC ecosystem: `Serverless` (13 total).
- Capability: `iacCodeBinding`.
