# Dogfood — Docker container graph

End-to-end run of the real `openlore` CLI (built `dist/`) on a fresh repository containing two
Dockerfiles and a docker-compose file. Date: 2026-06-23.

## Fixture repo

```
api/Dockerfile        # 3-stage: deps → builder (COPY --from=deps) → final (COPY --from=builder)
worker/Dockerfile     # single stage on python:3.12-slim
docker-compose.yml    # api(build target=builder), worker(build ./worker), db(postgres:16), cache(redis:7)
src/index.ts          # main() → startServer()   (regression control)
```

## Commands

```
openlore init
openlore analyze --no-embed      # 116ms, keyword (BM25) index
```

## Result — graph (from .openlore/analysis/llm-context.json)

12 Docker-tagged nodes, all edges correct (dependent → dependency):

```
api/Dockerfile::deps      --references--> node:20-alpine
api/Dockerfile::builder   --references--> node:20-alpine
api/Dockerfile::builder   --references--> api/Dockerfile::deps      (COPY --from=deps)
api/Dockerfile::stage2    --references--> api/Dockerfile::builder   (COPY --from=builder)
api/Dockerfile::stage2    --references--> node:20-alpine
worker/Dockerfile::stage0 --references--> python:3.12-slim
docker-compose.yml::service.api    --references--> api/Dockerfile::builder   (build target=builder, cross-file)
docker-compose.yml::service.api    --depends_on--> docker-compose.yml::service.db
docker-compose.yml::service.api    --depends_on--> docker-compose.yml::service.cache
docker-compose.yml::service.worker --references--> worker/Dockerfile::stage0 (build ./worker → final stage)
docker-compose.yml::service.worker --depends_on--> docker-compose.yml::service.db
docker-compose.yml::service.db     --references--> postgres:16
docker-compose.yml::service.cache  --references--> redis:7
main --calls--> startServer    # general-purpose extraction NOT regressed
```

External image nodes are deduped (one `node:20-alpine` node shared by all three api stages).

## The high-value query — blast radius across the code↔infra boundary

"What rebuilds if `node:20-alpine` moves?" (reverse reachability over `node:20-alpine`):

```
api/Dockerfile::deps     [Dockerfile]
api/Dockerfile::builder  [Dockerfile]
api/Dockerfile::stage2   [Dockerfile]
docker-compose.yml::service.api  [Docker Compose]   ← cross-file, transitive
```

The `api` compose service is correctly flagged (it builds the `builder` stage, which derives from
`node:20-alpine`); the `worker` service (python base) is correctly NOT flagged. This is exactly the
deterministic, no-LLM reachability answer the IaC arc promises, now extended to containers.

## orient (real MCP-backed CLI)

```
openlore orient --task "postgres database service dependencies"
  → postgres:16, docker-compose.yml::service.{api,cache,db,worker} surfaced as relevant nodes
```

## Verdict

`analyze → graph → orient` works end-to-end on real container files with zero MCP-tool or schema
changes. No regression to general-purpose or other IaC extraction (full suite: 4692 passed / 2 skipped).

## Adversarial hardening (PR review, 2026-06-24)

Three parallel adversarial e2e agents dogfooded real-world Dockerfiles and compose files
(multi-stage builds, Airflow-style compose, popular-project shapes). They found and we fixed four
real defects; all are now locked by regression tests in `docker.test.ts`:

| Bug | Symptom | Fix |
|-----|---------|-----|
| Heredoc body scanned | `FROM`/`COPY --from` inside `RUN <<EOF … EOF` became bogus stages/edges | `toInstructions` skips heredoc bodies |
| Line continuation | `FROM \`⏎`python:3.12 AS app` captured `\` as an image, lost the real base + stage name | `toInstructions` joins `\` continuations |
| Trailing inline comment | `FROM python:3.12-slim # pinned` failed the `$`-anchored regex → whole Dockerfile vanished, or (multi-stage) missing stage + bogus external image + wrong edge | `FROM_RE` tolerates a trailing `# …` |
| YAML merge key | `x-*: &anchor` + `<<: *anchor` (Airflow) left inherited `image`/`depends_on`/`build` under a literal `<<` → missed edges | `parseDocument(content, { merge: true })` |
| (hardening) malformed YAML | recoverable syntax errors minted a garbage service node | bail when `doc.errors.length > 0` |

Final comprehensive dogfood — an Airflow-style repo combining all of the above (merge keys + heredoc +
trailing comments + dynamic `ARG` base + multi-stage + cross-file `build.target`) — passes 12/12
end-to-end checks through the real `openlore analyze` CLI:

- dynamic `FROM node:${NODE_VERSION}` → stage node, **no** edge, no `${}` node minted;
- heredoc `FROM` → not a node;
- `COPY --from=` chains resolve (builder→deps, final→builder);
- trailing-comment `FROM` → correct base-image edge;
- merged `<<: *common` → `webserver`/`worker` inherit `image` + `depends_on`;
- `webserver` has `build:` so the merged `image:` is correctly the build tag (no image edge), while
  `worker` (no build) gets the image edge.

No regressions: full suite 4700 passed / 2 skipped; lint + typecheck clean.

## Adversarial round 2 + edge-store verification (2026-06-24)

A second adversarial pass (one e2e agent dogfooding **real OSS repos** — `docker/awesome-compose`
and Apache Airflow's canonical `docker-compose.yaml` — plus targeted probing) found two more real
defects, now fixed and regression-tested (`docker.test.ts`: 21→28):

| Bug | Symptom | Fix |
|-----|---------|-----|
| Stage-name case sensitivity | `FROM x AS Builder` + `COPY --from=builder` → bogus external image `builder` + wrong edge (Docker stage names are case-insensitive) | lookup map keyed lowercase; `FROM`/`COPY --from`/compose `target` lowercased before lookup |
| `${VAR:-default}` interpolation dropped | `image: ${AIRFLOW_IMAGE_NAME:-apache/airflow:3.0.0}` produced no edge → 8/10 Airflow services had no base-image dependency (defeats blast-radius) | `resolveRef()` substitutes inline `${VAR:-default}` / `${VAR-default}` defaults across `image`, `FROM`, `COPY --from`, and `build.context`/`build.dockerfile`; truly-dynamic refs (`${VAR}`, `${VAR:?err}`) stay edge-less |

**Edge-store persistence verified.** Confirmed Docker nodes AND edges land in the production SQLite
edge store (`call-graph.db`) — the substrate `analyze_impact`/`get_subgraph`/`blast_radius` read,
not just `llm-context.json`:

```
sqlite3 call-graph.db "SELECT language, COUNT(*) FROM nodes GROUP BY language;"
  Docker Compose|2   Dockerfile|5
-- edges (caller → callee, kind), persisted:
  svc/Dockerfile::build   → golang:1.22            references
  svc/Dockerfile::runtime → gcr.io/distroless/base references
  svc/Dockerfile::runtime → svc/Dockerfile::build  references   (COPY --from=build)
  docker-compose.yml::service.svc → svc/Dockerfile::runtime     references   (build → final stage)
  docker-compose.yml::service.svc → docker-compose.yml::service.db  depends_on
  docker-compose.yml::service.db  → postgres:16    references
```

**Real-OSS dogfood (`docker/awesome-compose`, 531 files):** `analyze` 5.4s, exit 0, no Docker
warnings. 150 Dockerfile + 81 Docker Compose nodes; 210 `references` + 26 `depends_on` edges,
all persisted to `call-graph.db`. Spot-checked against source: multi-stage `FROM` chains, `COPY
--from` (stage + external), `--platform` stripping, `build`/`build.target`, `depends_on`, external
image dedup across files, and Airflow merge-key inheritance all match the real files.

No regressions: full suite 4707 passed / 2 skipped; lint + typecheck clean.

## Adversarial round 3 — ARG-parameterized base images (2026-06-24)

Probing the most common real-world Dockerfile pattern still missed: a base image parameterized by a
build arg (`ARG NODE_VERSION=20` … `FROM node:${NODE_VERSION}-alpine`) — used by virtually every
official multi-version image. Round 2 resolved only *inline* `${VAR:-default}`; an `ARG`-declared
default produced **no edge**, leaving the base-image dependency invisible (same blast-radius gap as the
Airflow `image:` issue).

| Bug | Symptom | Fix |
|-----|---------|-----|
| `ARG NAME=default` not resolved in `FROM` | `ARG NODE_VERSION=20` + `FROM node:${NODE_VERSION}` → no base-image edge | collect global ARG defaults (declared before the first `FROM`, per Docker); `resolveRef(value, args)` substitutes `${NAME}`/`$NAME` from that map across `FROM` and `COPY --from` |

Docker semantics honored precisely: only ARGs **before the first `FROM`** are global and apply to `FROM`
lines — a stage-scoped `ARG` (declared after a `FROM`) is correctly *not* applied to a later `FROM`.
Bare `${VAR}`/`$VAR` with no inline or ARG default still stays edge-less; chained ARG defaults
(`ARG IMG=node:$V`) stay conservatively edge-less (no wrong edge).

Full-CLI dogfood — a repo whose Dockerfile uses **two** ARGs in one ref and a distroless image, plus a
compose with `build`+interpolated `image:`:
```
FROM node:${NODE_VERSION}-alpine${ALPINE_VERSION}   →  node:20-alpine3.20   (both ARGs resolved)
FROM gcr.io/distroless/nodejs${NODE_VERSION}-debian12 → gcr.io/distroless/nodejs20-debian12
-- persisted in call-graph.db, deterministic across two --force runs:
  api/Dockerfile::deps    → node:20-alpine3.20
  api/Dockerfile::builder → node:20-alpine3.20  +  → api/Dockerfile::deps (COPY --from)
  api/Dockerfile::stage2  → gcr.io/distroless/nodejs20-debian12  +  → api/Dockerfile::builder
  service.api → api/Dockerfile::builder (build target; image: ${REGISTRY:-…} correctly NOT an edge)
  service.api → service.db (depends_on);  service.db → postgres:16
```

Other probes this round — all PASS (no crash, no wrong edge): `ARG IMAGE=node:20`/`FROM $IMAGE`
(resolves), `COPY --from=$ARG` (dynamic, siblings intact), compose `configs`/`secrets`/`profiles`/
`env_file`/`build.args` (no bogus nodes), 200-stage Dockerfile (399 edges, 1ms).

No regressions: full suite 4712 passed / 2 skipped; lint + typecheck clean. (+5 ARG regression tests;
`docker.test.ts` 28→33.)
