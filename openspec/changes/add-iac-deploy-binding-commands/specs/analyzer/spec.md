# analyzer spec delta

## ADDED Requirements

### Requirement: CommandsBindToTheScriptTheyRun

A Dockerfile `CMD`/`ENTRYPOINT` and a Kubernetes container `command`/`args` SHALL bind to the
indexed code they run by a `deploys_symbol` edge when they name a source location literally,
resolved through the project's own build-output mapping where the path is built output. A command
that is not literal, or whose script names no single indexed entry, SHALL be a disclosed
unresolved binding.

#### Scenario: A container command binds to its script

- **GIVEN** a Dockerfile `CMD ["node", "dist/server.js"]` and a `tsconfig.json` mapping `dist` to `src`
- **WHEN** the repository is analyzed
- **THEN** the image resource has a `deploys_symbol` edge to the entry of `src/server.ts`

#### Scenario: A shell-form command is disclosed

- **GIVEN** a Dockerfile `CMD npm start && tail -f /dev/null`
- **WHEN** the repository is analyzed
- **THEN** no edge is created and the binding is disclosed as unresolved with its reason
