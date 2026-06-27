# Tasks — Docker container graph

## 1. Types & gating
- [x] Add `Dockerfile` and `Docker Compose` to the `IacLanguage` union and `IAC_LANGUAGES` array
  (`src/core/analyzer/iac/types.ts`).

## 2. Extractor
- [x] New `src/core/analyzer/iac/docker.ts`:
  - [x] `extractDocker(files)` splits input by language and parses Dockerfiles + compose together.
  - [x] Dockerfile: stages, `FROM` (stage→stage | stage→external image), `COPY/ADD --from=` edges.
  - [x] Compose: services, `depends_on`/`links`, `build:`→Dockerfile stage (final or `target`),
        `image:`→external (only when no `build:`).
  - [x] External image dedup under canonical `Dockerfile` tag; dynamic refs emit no edge.
  - [x] `isDockerfilePath(path)` predicate (exported).

## 3. Detection & dispatch
- [x] `classifyYaml` returns `Docker Compose` for compose filenames (`src/core/analyzer/iac/classify-yaml.ts`).
- [x] `index.ts` wires `extractDocker` into `buildIacGraph`; re-exports `isDockerfilePath`.
- [x] `artifact-generator.ts`: add both tags to `CALL_GRAPH_LANGS`; `resolveLang` recognizes Dockerfiles.

## 4. Tests & fixtures
- [x] `src/core/analyzer/iac/docker.test.ts` — Dockerfile multi-stage, compose depends_on, cross-file
      build→stage→base-image chain, dynamic-ref no-edge, determinism.
- [x] Fixtures under `src/core/analyzer/iac/fixtures/docker/`.
- [x] Extend `integration.test.ts` to assert Docker nodes/edges surface through `CallGraphBuilder`.

## 5. Verify & dogfood
- [x] `npm run lint`, `npm run typecheck`, `npm run test:run`, `npm run build` green.
- [x] Dogfood: `openlore analyze` a real repo with Dockerfile + compose; `analyze_impact` a base image;
      record results in `DOGFOOD-docker-container-graph.md`.

## 6. Docs
- [x] Mark spec-07's deferred Dockerfile/compose item as shipped (status note).
- [x] Update proposal status to IMPLEMENTED.
