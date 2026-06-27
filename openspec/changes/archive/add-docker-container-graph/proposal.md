# Docker container graph: Dockerfile + Compose dependency edges on the existing IaC projector

> Status: IMPLEMENTED (2026-06-23) — branch `feat/docker-container-graph`. The container layer
> deferred from spec-07 (see spec-07 "Out of scope" line: *Dockerfile, docker-compose*). Builds
> directly on the spec-07 IaC subsystem (`src/core/analyzer/iac/`): the normalized
> `IacResource`/`IacReference`/`IacGraph` intermediate and the single `project.ts` projector onto
> `FunctionNode`/`CallEdge`. No graph-schema, MCP-tool, or `orient` changes.
> See "Implementation status" at the foot of this file.

## Why

OpenLore already ingests eight IaC ecosystems (Terraform, Kubernetes, Helm, CloudFormation, Ansible,
Pulumi, CDK, CDKTF) by projecting a normalized resource graph onto the existing call-graph primitives,
so `orient`, `search_code`, `get_subgraph`, `analyze_impact`, and `blast_radius` answer "who depends
on this?" over infrastructure with zero tool changes.

The one container layer almost every repository actually has — **Dockerfiles and docker-compose** — is
still invisible. It was explicitly deferred from spec-07 to keep that PR bounded. Yet "if I change this
base image / this Dockerfile, which services break?" and "what does this compose service depend on?" are
exactly graph-reachability questions, and the container topology is the most common piece of infra a
coding agent encounters. Closing it is the highest-prevalence, lowest-risk increment left in the IaC arc.

The container world maps cleanly onto the existing primitives — it is dependency-graph-shaped, dependent
→ dependency, just like the rest of IaC:

| Container concept | OpenLore graph primitive |
|---|---|
| A Dockerfile build stage (`FROM … AS x`) | a node (`FunctionNode`) |
| A compose service | a node |
| A base image / registry image (`node:20`, `alpine`) | an external node (`isExternal`) |
| `FROM <base>` / `COPY --from=<stage>` | an edge, stage → its base/source stage |
| `depends_on` / `links` between services | an edge, service → dependency (`depends_on`/`references`) |
| `build: { context, dockerfile, target }` | an edge, **service → the Dockerfile stage it builds** (cross-file) |
| `image: <ref>` (no build) | an edge, service → external image |

The high-value edge is the **cross-file** one: a compose service's `build:` resolves to the final (or
named `target`) stage of the referenced Dockerfile, whose `FROM` in turn resolves to a base image. So a
single `analyze_impact` on `python:3.12-slim` answers "every Dockerfile stage and every compose service
that would be rebuilt if this base image moved" — end to end, deterministically, no LLM.

## What changes

1. **Two new IaC language tags** — `Dockerfile` and `Docker Compose` — added to the `IacLanguage` union
   and `IAC_LANGUAGES` (the single source of truth for IaC dispatch and gating). They ride the existing
   projector; `isIacLanguage` therefore already treats them as infra everywhere (dead-code roots,
   cross-domain linking, graph handlers).

2. **A `docker.ts` extractor.** A single `extractDocker(files)` parses **both** Dockerfiles and compose
   files together (it needs both for cross-file resolution) and returns a normalized `IacGraph`:
   - **Dockerfile**: one node per build stage (named `AS` stage or `stage<index>`). `FROM` resolves to an
     earlier same-file stage when the base names one, else to an external image node. `COPY/ADD --from=`
     resolves to a stage (by name or build index) or an external image.
   - **Compose**: one node per service. `depends_on` and `links` → service→service edges. `build:` →
     service → the resolved Dockerfile stage (final stage, or `target` when given). `image:` (when there
     is no `build:`) → service → external image.
   - **Determinism & honesty**: external image nodes are deduped by reference under one canonical
     `Dockerfile` language tag, so a base image referenced from both a Dockerfile and a compose `image:`
     is a single node. Dynamic refs (`FROM ${ARG}`, fully-templated build context) emit **no edge** —
     `TODO(spec-07-followup): dynamic …` — never a wrong one. Output is sorted (the projector already
     sorts), so rebuilds are byte-identical.
   - **Real-world syntax robustness** (hardened by four rounds of adversarial e2e review — see DOGFOOD
     notes): the Dockerfile scanner reduces source to logical instructions first — joining `\` line
     continuations and **skipping heredoc bodies** (a `FROM` inside `RUN <<EOF … EOF` is never a stage)
     — tolerates trailing inline comments on `FROM` lines, treats **stage names case-insensitively**
     (BuildKit semantics), and handles CRLF, `--platform=`, lowercase `from … as`, digest pins, and
     numeric `COPY --from=0`. Variable references resolve to a **known default** — both inline
     (`image: ${AIRFLOW_IMAGE_NAME:-apache/airflow:3.0.0}`, `FROM ${BASE:-node:20}`,
     `dockerfile: ${DF:-Dockerfile}`) and from a global **`ARG NAME=default`** declared before the first
     `FROM` (`FROM node:${NODE_VERSION}` — the dominant base-image parameterization; stage-scoped ARGs
     are correctly *not* applied to `FROM`, per Docker). A `${VAR}`/`$VAR` with no inline or ARG default
     stays edge-less. The compose parser expands YAML **merge keys** (`x-*: &anchor` / `<<: *anchor`, the
     Airflow extension pattern) and ignores recoverable-but-malformed YAML rather than minting a garbage
     node.

3. **Detection in the analyze-time `resolveLang` layer, not `detectLanguage`.** Consistent with every
   other IaC ecosystem: `detectLanguage` (which the incremental watcher consults) stays unchanged, so a
   Dockerfile edit never reaches the watcher's empty-result node-deletion path. Dockerfiles are
   recognized by path (`Dockerfile`, `Dockerfile.*`, `*.Dockerfile`, `Containerfile`); compose files by
   `classifyYaml` (the existing YAML router) via filename (`docker-compose*.y?ml`, `compose*.y?ml`).
   `CALL_GRAPH_LANGS` gains both tags so the files reach the IaC projection pass.

## Scope contract — do not break these things

This change must NOT:
- Change the `FunctionNode` / `CallEdge` / `ClassNode` schema, the MCP tools, or `orient`. Docker rides
  the existing primitives, exactly like spec-07.
- Regress any existing language or IaC ecosystem. All current extractors and tests stay green.
- Touch `detectLanguage` (and therefore the incremental watcher's deletion-sensitive path) or expand the
  watcher's `CALL_GRAPH_LANGS` — Docker matches the established analyze-time IaC limitation (full
  re-analyze picks up changes; same as Terraform/K8s YAML today).
- Evaluate anything: no `docker build`, no compose interpolation against a real env, no registry calls.
  Static parse only.
- Over-promise precision. Emit only statically-resolvable edges; for the rest emit nothing and leave a
  `TODO(spec-07-followup): …`.

## Out of scope (deferred, as spec-07 deferred these)

Bicep, ARM JSON, Kustomize, Crossplane, Dockerfile `HEALTHCHECK`/`ENTRYPOINT` command graphs, compose
`volumes`/`networks` as first-class nodes (low signal, high noise), cross-file compose `extends` to
another file, and incremental-watch support for container files (matches all IaC YAML today).

## Implementation status

Tracked in `tasks.md`. Verified by `src/core/analyzer/iac/docker.test.ts` (unit) and the IaC
`integration.test.ts` (end-to-end through `CallGraphBuilder`), plus a dogfood run recorded in
`DOGFOOD-docker-container-graph.md`.
