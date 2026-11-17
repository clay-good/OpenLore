# Bind container commands to the script they run

> Priority: P3 · Not built
> Reaches the agent through: `orient` (its deploy briefing, `deploy-briefing.ts`)
> Why it helps the agent: when it edits a script a container runs, it sees which image or pod runs it.

## Problem

OpenLore binds a Lambda-style handler in Terraform, CloudFormation/SAM, and Serverless to the
function it names (`deploys_symbol` edges, `deploy-binding.ts`). A Dockerfile `CMD`/`ENTRYPOINT` or
a Kubernetes container `command`/`args` names a script too, but no reader binds it today:
`IAC_CODE_BINDING_LANGUAGES` lists Terraform, CloudFormation, and Serverless only. So when the agent
edits `src/server.ts`, `orient` does not say that an image runs it.

## What changes

- **Decide what a script binds to.** A command names a file, not an export, and the graph has no
  node for a file's module-level code. Options: the file's single unambiguous entry (`main`, or a
  single top-level export), with every other case disclosed; or a new module-entry node. Record the
  choice with `openlore decisions record`.
- **Dockerfile reader** (`iac/docker.ts`): exec-form `CMD`/`ENTRYPOINT` that names a source or built
  file fills `IacResource.deploys`.
- **Kubernetes reader** (`iac/kubernetes.ts`): a container's literal `command`/`args` that names a
  file does the same.
- **Binding** (`iac/deploy-binding.ts`): built paths map to source through the shipped
  build-output mapping (`iac/build-output.ts`); Docker and Kubernetes join
  `IAC_CODE_BINDING_LANGUAGES`, so the `iacCodeBinding` capability row updates itself.
- **Delivery:** the existing `orient` deploy briefing names the image or pod that runs the edited
  script. No new field name is needed.

## What does not change

- No new tool, field rename, or CLI command. Local only; nothing runs the container.
- Works with any spec workflow or none.

## Limits we disclose

- Shell-form commands (`CMD npm start && …`), variables, and package scripts (`npm start`) are not
  followed; each is an unresolved binding with its reason.
- A script with no single indexed entry is unresolved, never guessed.

## Depends on

Shipped code: `deploy-binding.ts`, `build-output.ts`, `deploy-briefing.ts` (from #662).
