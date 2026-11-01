# IaC deploy binding, part 3: container commands

> Status: PROPOSED (2026-11-01). Split from `add-iac-deploy-binding`, whose Lambda handler binding
> (Terraform, CloudFormation/SAM) shipped, and then from
> `add-serverless-and-build-output-binding`, which shipped the Serverless reader, the build-output
> mapping, the `orient` field, and the `iacCodeBinding` capability.

## What changes

| Part | What it does |
|------|--------------|
| Commands | Dockerfile `CMD`/`ENTRYPOINT`, Kubernetes `command`/`args` naming a script bind to its module entry |

A command names a SCRIPT, not an export, so this change has to settle what it binds to: the graph
has no node for a file's module-level execution. Options are the file's unambiguous entry (`main`,
a single top-level export) with the ambiguous case disclosed, or a new module-entry node. The
build-output mapping those paths need already shipped.

## Impact

- Specs: `analyzer` — 1 ADDED.
