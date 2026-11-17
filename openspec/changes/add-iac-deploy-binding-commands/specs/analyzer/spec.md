# analyzer spec delta

## ADDED Requirements

### Requirement: CommandsBindToTheScriptTheyRun

When this change is built, a Dockerfile exec-form `CMD`/`ENTRYPOINT` and a Kubernetes container
`command`/`args` that name a file literally SHALL bind to the indexed entry of that file by a
`deploys_symbol` edge. A built path SHALL be mapped to its source through the project's own
build-output mapping. A command that is not literal, or a file with no single indexed entry, SHALL
produce no edge and SHALL be reported as an unresolved binding with its reason.

#### Scenario: A container command binds to its script

- **GIVEN** a Dockerfile `CMD ["node", "dist/server.js"]` and a `tsconfig.json` that maps `dist` to `src`
- **WHEN** the repository is analyzed
- **THEN** the image resource has a `deploys_symbol` edge to the entry of `src/server.ts`

#### Scenario: A shell-form command is disclosed

- **GIVEN** a Dockerfile `CMD npm start && tail -f /dev/null`
- **WHEN** the repository is analyzed
- **THEN** no edge is created and the binding is reported as unresolved with its reason
