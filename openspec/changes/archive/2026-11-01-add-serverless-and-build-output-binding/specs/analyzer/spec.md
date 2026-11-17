# analyzer spec delta

## ADDED Requirements

### Requirement: ServerlessFunctionsBindToTheirHandlers

The analyzer SHALL read a Serverless Framework service manifest (`serverless.yml`, `.yaml`, or
`.json`, corroborated by its content) and project each `functions.<name>` as a resource grouped
under the service, whose `<module>.<export>` handler binds to the indexed function it names by a
`deploys_symbol` edge, resolved relative to the manifest's own directory and the repository root.
A function that runs a container image, declares no handler, or builds its handler from a
Serverless variable SHALL be recorded as an unresolved binding with that reason.

#### Scenario: A Serverless function binds to its handler

- **GIVEN** a `serverless.yml` declaring `functions.createOrder.handler: src/orders.create` and an
  indexed `create` in `src/orders.ts`
- **WHEN** the repository is analyzed
- **THEN** the graph holds a `deploys_symbol` edge from `function.createOrder` to `create`

#### Scenario: A variable handler is disclosed, not guessed

- **GIVEN** a function whose handler is `${self:custom.base}.handler`
- **WHEN** the repository is analyzed
- **THEN** no edge is created and the binding is disclosed as unresolved, naming the variable as
  the reason

#### Scenario: A Serverless manifest's environment block sets a variable

- **GIVEN** a `serverless.yml` whose `provider.environment` sets `TABLE_NAME`
- **WHEN** the environment-declaration scan runs
- **THEN** the site is reported as setting `TABLE_NAME`, with its resource, file and line, and
  without its value

### Requirement: BuiltHandlersResolveThroughTheProjectsOwnMapping

A deployed handler that names built output SHALL resolve to its source only through a mapping the
project itself declares in the repository root's `tsconfig.json` or `package.json` — TypeScript's
`outDir` with `rootDir`, or `main` paired with `source`. An `extends` chain is not followed, and
the unresolved reason SHALL name what was read rather than assert the project declares no mapping. A path under a declared `outDir` that the project maps to no input SHALL
remain an unresolved binding naming the missing mapping; it SHALL NOT be matched to a
same-basename source file.

#### Scenario: A built handler reaches its source

- **GIVEN** a handler `dist/orders.handler`, a `tsconfig.json` with `outDir: dist` and
  `rootDir: src`, and an indexed `handler` in `src/orders.ts`
- **WHEN** the repository is analyzed
- **THEN** the resource has a `deploys_symbol` edge to `handler` in `src/orders.ts`

#### Scenario: An unmapped build output is disclosed

- **GIVEN** the same handler and a `tsconfig.json` declaring `outDir` but no `rootDir`, and no
  `main`/`source` pair
- **WHEN** the repository is analyzed
- **THEN** no edge is created and the unresolved binding names the missing mapping
