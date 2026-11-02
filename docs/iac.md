# Infrastructure-as-Code support

OpenLore models a codebase as a graph of nodes (functions/resources) and edges
(calls/references). Infrastructure-as-Code maps cleanly onto that same graph:
IaC is dependency-graph-shaped, and OpenLore already serves dependency queries.

Because IaC is **projected onto the existing graph primitives**
(`FunctionNode` / `CallEdge` / `ClassNode`), every graph tool works on
infrastructure with no changes: `orient`, `search_code`, `get_subgraph`,
`analyze_impact`, `trace_execution_path`, the SCIP export, and the federation
manifest.

## The mapping

| IaC concept | OpenLore graph primitive |
|---|---|
| A resource / manifest object / play / stack resource | a node (`FunctionNode`) |
| A reference (interpolation, `Ref`, selector, `notify`, `depends_on`) | an edge (`CallEdge`), **dependent → dependency** |
| A module / chart / role / stack | a grouping (`ClassNode`) |
| A provider / registry module / remote chart / base image | an external node (`isExternal`) |

Edge direction is **dependent → dependency**. So for any resource node:

- depth-1 **callers** = "who depends on this?" → **blast radius** (`analyze_impact`)
- **fanOut** = "what does this resource need?"

`FunctionNode.language` carries the ecosystem tag (`Terraform`, `Kubernetes`,
`Helm`, `CloudFormation`, `Ansible`, `Pulumi`, `CDK`, `CDKTF`, `Dockerfile`,
`Docker Compose`, `GitHub Actions`, `Bicep`, `Serverless`); `className` carries
the resource type, so clustering and architecture overviews group by type.

## What is extracted, per ecosystem

This is **static** analysis only. OpenLore never runs `terraform plan`, renders
Helm, executes Ansible, or calls a cloud API. No external CLI is required.

### Terraform / HCL  (`*.tf`, `*.tfvars`, `*.tf.json`; OpenTofu `*.tofu`, `*.tofu.json`)
- **Nodes:** `resource`, `data`, `module`, `variable`, `output`, `locals` (each local), `provider` (external).
- **Edges:** interpolation and bare references (`type.name.attr`, `var.x`, `local.y`, `module.m.out`, `data.t.n.attr`) and explicit `depends_on`. References to custom resource types without an underscore resolve too — candidates that match no declared resource are dropped, never invented.
- **Modules:** local `source = "./…"` links the module to the resources declared under that directory; registry/git sources become external module nodes.
- **JSON variant:** `*.tf.json` is parsed structurally (the same blocks as JSON objects; `${…}` strings carry references).
- **Notes:** HCL is parsed with a tolerant, hand-rolled scanner (no native dependency). `count`/`for_each` produce a single node for the block (noted in the signature).

### Kubernetes  (`*.yaml`/`*.yml` manifests; multi-doc supported)
- **Nodes:** one per document, `address = <kind>/<name>` (namespaced as `<ns>/<kind>/<name>`).
- **Edges:** `Service` label selectors → matching workloads, `configMapKeyRef`/`secretKeyRef`/`envFrom`, volume refs, `StatefulSet.serviceName` → `Service`, `ownerReferences`, `Ingress` → `Service`, `serviceAccountName`.
- **CRDs:** unknown kinds still become nodes (typed by the CRD kind), just with fewer typed edges.

### Helm  (a directory containing `Chart.yaml`)
- **Nodes:** the chart (grouping), named templates (`define`), referenced `values.yaml` keys, and best-effort template-defined resources (via a tolerant `{{ … }}` masking pre-pass — templates are never executed).
- **Edges:** chart → subchart dependencies (external unless vendored under `charts/`), template → named-template (`include`/`template` → `define`), and template → values (`.Values.x` resolved to the longest matching `values.yaml` key).

### CloudFormation / SAM  (`*.yaml`/`*.yml`/`*.json`)
- **Nodes:** `Resources.<LogicalId>` (typed by `Type`), `Parameters`, `Outputs`, `Mappings`, `Conditions`.
- **Edges:** `Ref`, `Fn::GetAtt`, `Fn::Sub` `${…}`, `DependsOn`, `Fn::ImportValue` (cross-stack → external), nested stacks (`AWS::CloudFormation::Stack` `TemplateURL` → external).
- **Notes:** YAML short-form intrinsics (`!Ref`, `!GetAtt`, `!Sub`, …) parse via a CFN-aware tag set. Pseudo-parameters (`AWS::Region`, …) are ignored.

### Ansible  (playbooks, `roles/<name>/{tasks,handlers,defaults,vars,meta}/main.yml`)
- **Nodes:** plays, named tasks, handlers, roles, role vars/defaults.
- **Edges:** `notify` (task → handler), `include_tasks`/`import_tasks`/`include_role`/`import_role`/`import_playbook`, `roles:` (play → role), role `meta` dependencies (role → role).
- **Notes:** Jinja2 `{{ }}` is tolerated. A templated include target backed by a static `loop`/`with_items` list resolves to each literal item; fully dynamic targets are dropped.

### Pulumi  (TS/JS/Python/Go programs)
- A **framework detector** over existing source — no new grammar. Recognizes provider SDK resource constructions (`@pulumi/aws`, `/gcp`, `/azure-native`, `/kubernetes`; Go: `github.com/pulumi/pulumi-*`).
- **Nodes:** each detected resource (`address = <Service>:<name>`, `language = Pulumi`).
- **Edges:** when one resource's args reference another resource's variable.
- The normal call graph for those files is unchanged.

### AWS CDK & CDKTF  (TS/JS/Python/Go programs)
- Framework detectors like Pulumi. The distinguishing shape is that a construct's **first** argument is the scope and the **second** is the logical id: `new s3.Bucket(this, "MyBucket", { … })` (CDK), `new S3Bucket(scope, "logs", { … })` (CDKTF).
- **Imports:** CDK = `aws-cdk-lib` / `@aws-cdk/*` / `aws_cdk` (Python) / `aws/aws-cdk-go` (Go); CDKTF = `cdktf` / `@cdktf/*` / `terraform-cdk-go` (Go). Go ids wrapped in `jsii.String("…")` are unwrapped.
- **Nodes:** each construct (`address = <Service>:<id>`, `language = CDK` or `CDKTF`).
- **Edges:** when one construct's args reference another construct's variable.
- Static detection only — OpenLore never runs `cdk synth` / `cdktf synth`.

### Docker  (`Dockerfile`, `Dockerfile.*`, `*.Dockerfile`, `Containerfile`; `docker-compose*.y?ml`, `compose*.y?ml`)
- **Nodes:** one per Dockerfile build **stage** (`FROM … AS x`, or `stage<index>` when anonymous); one per compose **service**; base/registry images are external nodes (`node:20`, `postgres:16`), deduped across all files.
- **Dockerfile edges:** `FROM` → an earlier same-file stage (when the base names one, case-insensitively) or the external base image; `COPY/ADD --from=` → a stage (by name or build index) or an external image. `FROM scratch` produces no edge; a base parameterized by a build arg with a known default (`ARG NODE_VERSION=20` … `FROM node:${NODE_VERSION}`) resolves to the default; a fully dynamic base (a `${VAR}`/`$VAR` with no inline or ARG default) produces no edge.
- **Compose edges:** `depends_on` and `links` → service→service; `build:` → the resolved Dockerfile stage (the final stage, or `target:` when given) — a **cross-file** edge; `image:` → external image (only when the service has no `build:`, since with `build:` the image is the output tag, not a dependency).
- **The high-value chain:** compose service → Dockerfile stage → base image, so a single `analyze_impact` on a base image surfaces every stage and service that would rebuild — across files, deterministically, no LLM.
- **Notes:** Dockerfiles and compose files are parsed *together* (they cross-reference). One extractor, both ecosystems. Static only — no `docker build`, no environment-based interpolation, no registry access — but inline `${VAR:-default}` defaults *are* resolved statically (see below).
- **Robustness (real-world syntax):** the Dockerfile scanner joins `\` line continuations, skips heredoc bodies (`RUN <<EOF … EOF` — a `FROM` inside a script is never a stage), ignores whole-line and trailing inline comments, treats stage names case-insensitively (BuildKit semantics), and handles CRLF, `--platform=…`, lowercase `from … as …`, digest pins, and numeric `COPY --from=0`. Variable references resolve to a known default — both inline (`image: ${AIRFLOW_IMAGE_NAME:-apache/airflow:3.0.0}`, `FROM ${BASE:-node:20}`, `dockerfile: ${DF:-Dockerfile}`) and from a global `ARG NAME=default` declared before the first `FROM` (`FROM node:${NODE_VERSION}`); a `${VAR}`/`$VAR` with no inline or ARG default stays edge-less. The compose parser expands YAML merge keys (`x-*: &anchor` / `<<: *anchor`, the Airflow-style extension pattern) and ignores recoverable-but-malformed YAML rather than minting a garbage node.

### GitHub Actions  (`.github/workflows/*.yml`, `action.yml`/`action.yaml`)
The CI/CD layer — the dependency graph nearly every repository on GitHub has. Modeled as
dependent → dependency, like the rest of IaC, so the same tools answer "which jobs break if I
change this?".
- **Nodes:** one **workflow** handle per workflow file (`<path>::workflow`, signature carries the
  `on:` triggers), one **job** per `jobs.<id>` (`<path>::job.<id>`), one **action** per
  `action.yml`/`action.yaml` (`<path>::action`, typed by `runs.using` — `composite` vs `action`),
  and external **action** nodes for marketplace/remote refs (`actions/checkout@v4`), deduped by
  reference so one action used by ten jobs is one node with fan-in 10.
- **Edges:** `needs:` → job→job (`depends_on`); a step's `uses:` → job→action (`references`); a
  job-level `uses:` (reusable workflow) → job→target workflow; a composite action's
  `runs.steps[].uses:` → action→action. So one `analyze_impact` on a shared composite action lists
  **every job in every workflow that would break if it changed**, and the reverse — a job's fanOut —
  is "everything this job pulls in".
- **`uses:` resolution:** a `./`-prefixed ref is local (resolved relative to the repo root) — a
  `.yml`/`.yaml` target is a reusable workflow, anything else is a local action directory; every
  other ref is external. Dynamic refs (`uses: ${{ matrix.action }}`, a partially-templated
  `org/action@${{ ver }}`) and unresolvable local refs emit no edge, never a wrong one. Static parse
  only — no `${{ }}` evaluation, no matrix expansion.
- **Real-world YAML robustness:** `${{ … }}` expressions are masked before parsing (GitHub tolerates
  them anywhere, but strict YAML rejects them inside a flow mapping like `with: { x: ${{ y }} }`, and
  the error would otherwise drop later jobs); YAML merge keys (`<<: *anchor`, shared job config) are
  expanded so an anchored job inherits its `steps`/`needs` edges; SHA pins with trailing comments,
  `docker://` actions, and `.yml`/`.yaml`/CRLF variants are all handled.

### Azure Bicep  (`*.bicep`)
- **Nodes:** every `resource` (typed by `Microsoft.Foo/bar`, the `@apiVersion` stripped), `param`, `var`, `output`, and `module`. An `existing` resource is kind `data`; a nested child `resource` declared inside another resource's body is its own node; a `[for … : { … }]` loop is a **single** node (noted in the signature). The node name is the bare symbol (`stg`), even though the resolution address is file-scoped.
- **Edges:** `parent:` → child → parent; `dependsOn: [ … ]` → dependent → each listed symbol; every other bare symbol used in a value → declaring symbol → referenced symbol. References are caught inside `${…}` string interpolations, as the base of a `.property` access (`stg.id` → `stg`), on **both** sides of the `::` nested-resource accessor (`vnet::subnet` → `vnet` and `subnet`), and as the source of a spread (`{ ...commonTags }` → `commonTags`). A conditional `resource x '…' = if (cond) { … }` keeps the condition's symbols as dependencies and still attributes nested children. Property keys, function names (`resourceGroup()`), and string-literal text are not references.
- **Modules:** a local `module './net.bicep'` links (cross-file) to every resource declared in the target file and groups them as a `ClassNode`; a registry/template-spec module (`br/…`, `ts/…`) is an external node.
- **File-scoped resolution:** Bicep resolves bare identifiers against a flat **per-file** symbol table (no `var.`/`type.name` prefixes), so the same name (`location`, `vnet`) recurs across files. Addresses are scoped by file (`<file>::<symbol>`) and references resolve **within the declaring file only** — two files each declaring `param location` never cross-link. The single cross-file edge is the local-`module` link above.
- **Notes:** parsed with a tolerant, hand-rolled scanner (no Bicep compiler, no native dependency). Static only — no `bicep build`, no ARM emit, no Azure/registry access. A multi-line ternary value (`= cond\n ? a\n : b`) resolves only the first line's symbols; the others are dropped rather than guessed.

### Serverless Framework  (`serverless.yml`, `.yaml`, `.json`)
- **Nodes:** the service, and one resource per `functions.<name>` grouped under it. The file name is the signal; a `service:` key, or `provider:` + `functions:`, corroborates it, so a same-named file is not misclassified.
- **Edges:** each function → its service (`depends_on`).
- **Handlers:** `functions.<name>.handler` binds like a Lambda's (below), with the function's own `runtime` overriding the provider's. A function that runs a container `image`, declares no handler, or builds its handler from a `${...}` variable is a disclosed unresolved binding.
- **Notes:** static only — no plugin execution, no `${...}` resolution, no `sls package`. A manifest's own `resources.Resources` block (CloudFormation written inside a Serverless file) is **not read at all** — dispatch is by language tag, so the CloudFormation extractor never sees a file tagged `Serverless`. Those resources are absent from the graph.

## The code a function resource runs

A Lambda names its code as `<module>.<export>`. A Terraform `aws_lambda_function` with a literal
top-level `handler`, a CloudFormation/SAM `AWS::Lambda::Function` / `AWS::Serverless::Function`
with a string `Handler`, or a Serverless `functions.<name>.handler`, gets a `deploys_symbol` edge
to the one indexed top-level function it names: `src/orders.handler` → `handler` in `src/orders.ts`; `app.lambda_handler` with
`CodeUri: functions/` → `lambda_handler` in `functions/app.py` (relative to the template).

- **Where the module is looked for:** under the code location only when one is known (SAM
  `CodeUri`, Terraform `source_dir`); else beside a CloudFormation template; else, for Terraform,
  at the repository root or beside the `.tf` file, and only for a module path with a directory in it
  (a bare `index.handler` names a file inside a package built elsewhere). SAM `Globals.Function`
  applies to `AWS::Serverless::Function` only.
- **Which files:** the runtime picks them (`nodejs*` → TypeScript/JavaScript, `python*` → `.py`, a
  Python module path uses `/`); other runtimes (Java, Go, .NET, custom) are not bound.
- **Built output:** a handler that names the built file (`dist/orders.handler` — the common case
  once a project compiles) reaches its source through a mapping the **project itself declares**:
  TypeScript's `compilerOptions.outDir` with `rootDir`, or a package manifest's `main` paired with
  `source`. Read from the **repository root's** `tsconfig.json` and `package.json` only, and an
  `extends` chain is not followed — so a monorepo whose mapping lives in `packages/api/tsconfig.json`,
  or a root config that inherits `rootDir`, has no mapping here, and the unresolved reason says so. A path under a declared `outDir` the project maps to no input stays unresolved and says
  so: an output path says nothing about where its input lives, and a same-basename file elsewhere
  would be a similarity match, which this substrate does not make.
- **Exactly one:** a module that matches more than one file, or a name with no single top-level
  function in it (class methods do not count), is not bound.
- `find_dead_code` counts a bound function as deployed (live): `rootKinds.deployed`.
  `analyze_impact` on the function reaches the resource.
- Everything else is listed in `unresolvedDeployBindings` (in `find_dead_code`) with the reason,
  because the code it runs can appear dead: an expression or intrinsic handler, inline code, code in
  S3, a build-output path (`dist/…`) with no indexed source, an unsupported runtime, an ambiguous
  module, a handler passed to a Terraform module. Container images are not bound.

## Environment variables set by infrastructure

`analyze_env_impact` names the files that set a variable (`declaredBy`), and `blast_radius` lists
the files that still set a variable the diff stopped reading (`envDeclarations`). Each site records
the key, the resource, the file and line, and whether a value is written there literally — never
the value itself. The scan runs at query time over the working tree.

| Ecosystem | Where a variable is set |
|-----------|-------------------------|
| Kubernetes | a container's `env` (any `containers`, `initContainers`, `ephemeralContainers` list) |
| Docker Compose | a service's `environment` (map or `KEY=value` list) |
| Dockerfile | `ENV KEY=value` and `ENV KEY value` |
| Terraform / OpenTofu | `environment { variables = { … } }`; the kubernetes provider's `env { name = … }` |
| Serverless | `provider.environment` (service-wide) and each `functions.<name>.environment` |
| CloudFormation / SAM | `Environment.Variables` on a resource and in `Globals.Function`; ECS `ContainerDefinitions[].Environment` |
| GitHub Actions | `env` on the workflow, a job, a job container or service, and a step |

A source whose keys cannot be listed — Kubernetes `envFrom`, compose `env_file`, or an environment
map built by an expression — is reported in `opaqueEnvSources`: the variable may be set there.
Helm templates are not rendered, so they are skipped and disclosed. A variable no file sets is
`undeclared-in-corpus`, which is not "unset": runtime injection, secret stores, and CI variables
defined outside the repository are not visible.

## Discovery & disambiguation

`.tf`/`.tfvars`/`.tf.json` and OpenTofu's `.tofu`/`.tofu.json` map to Terraform by extension; `.bicep` maps to Bicep
by extension (both via `detectLanguage`). `.yaml`/`.yml`/`.json` are ambiguous, so
they route through a small pure function, `classifyYaml(path, content)`:

- `apiVersion:` + `kind:` → **Kubernetes**
- `AWSTemplateFormatVersion` / `Transform: AWS::Serverless` / `Resources:` with `Type: AWS::…` → **CloudFormation**
- `Chart.yaml`, or a `{{ … }}` template under `templates/`, or any file under a chart directory → **Helm**
- top-level `hosts:`/playbook list, or a file under `roles/*/{tasks,handlers,…}/` → **Ansible**
- a `.github/workflows/*.y?ml` with `on:` + `jobs:`, or an `action.y?ml` with `runs:` → **GitHub Actions**
- a `docker-compose*.y?ml` / `compose*.y?ml` filename with a top-level `services:` key → **Docker Compose**
- a `serverless.yml` / `.yaml` / `.json` filename with a `service:` key, or `provider:` + `functions:` (either spelling, YAML or JSON) → **Serverless**
- otherwise → `null` (left as generic config — app config and other CI systems are never misclassified as IaC)

Dockerfiles have no extension to switch on, so they are recognized by name in the
analyze-time resolution layer (not `detectLanguage`), keeping the incremental
watcher's path unchanged — consistent with how all IaC YAML is resolved.

## Limits & conservatism

- A reference becomes an edge **only** when the target is unambiguous within the project. Computed names, `for_each` keys, fully-templated values, and dynamic includes produce **no edge** (marked `TODO(spec-07-followup)`), never a wrong one.
- Declared resources are never dropped — only unresolved *edges* are.
- Re-analyzing an unchanged IaC tree yields an identical graph (stable ids, sorted edges).

## Out of scope (future specs)

ARM JSON, Kustomize, Crossplane, Jsonnet/CUE, Nix, Bazel/Starlark, Packer,
Vagrant, and non-GitHub CI systems (GitLab CI, CircleCI, Azure Pipelines). For
GitHub Actions specifically: `${{ matrix }}` fan-out as distinct nodes,
step-level granularity (the job is the unit), and remote reusable-workflow
*contents* (an external ref is a node, not fetched). Also deferred for Docker
specifically: compose `volumes`/`networks` as first-class nodes, cross-file
compose `extends`, and incremental-watch of container files (matches all IaC
YAML today). Also deferred for Bicep specifically: `.bicepparam` parameter
files, `import`/user-defined functions and types, and cross-file `module`
**output** type-resolution (the module links to the target file's resources, not
to specific output symbols).
