# analyzer spec delta

## ADDED Requirements

### Requirement: CommandsAndServerlessHandlersBindToCode

A Dockerfile `CMD`/`ENTRYPOINT`, a Kubernetes container `command`/`args`, and a Serverless
`functions.*.handler` SHALL bind to the indexed code they run by a `deploys_symbol` edge when they
name a source location literally (a script path binds to that file's module-level entry). A
build-output path SHALL bind only through the project's own `outDir` or package `main` mapping.
Anything else SHALL be a disclosed unresolved binding.

#### Scenario: A container command binds to its script

- **GIVEN** a Dockerfile `CMD ["node", "dist/server.js"]` and a `tsconfig.json` mapping `dist` to `src`
- **WHEN** the repository is analyzed
- **THEN** the image resource has a `deploys_symbol` edge to the module entry of `src/server.ts`
