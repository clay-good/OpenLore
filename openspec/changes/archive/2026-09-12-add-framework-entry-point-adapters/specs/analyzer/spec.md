# analyzer spec delta

## ADDED Requirements

### Requirement: FrameworkEntryPointAdapters

The analyzer SHALL provide deterministic entry-point adapters — readers of declarative config (stage 1:
the root package.json `bin`/`main`/`module`/`exports`, npm scripts, and `jest` setup files, with build
outputs mapped back to their sources through tsconfig `outDir`/`rootDir`; stage 2: vitest/vite/jest
setup files and tsconfig `files`; stage 3: GitHub Actions `run:`-step scripts, parsed with the workflow
parser's expression masking) — each producing liveness evidence that extends the dead-code roots
definition with an `externally-wired` root kind carrying an auditable receipt (config file and key).
A command SHALL count a file only when it executes it (the script a runner runs, a preload, or a path
in command position), never a path passed as an argument, a redirect target, or heredoc content. Every
function in a config-wired file SHALL be a root, because module-scope code has no call-graph node, and
conclusions SHALL say so. An adapter SHALL only ever add evidence of use and SHALL never assert
deadness. A reference built from a variable, expression, or glob, an unsupported command form, a
missing or unmapped target, a path outside the repository, and a config that cannot be read or parsed
SHALL surface as disclosed boundaries with a reason, never as guesses; reading SHALL not follow links
or block on non-regular files. Config formats outside the supported set — workspace-member manifests,
framework route conventions, and others — SHALL be named as unread in the caveats. Downstream
conclusions SHALL consume the evidence: a config-wired untested gap carries its receipt and is not
flagged also-dead, and the entry-points digest separates entry points in files a config invokes from
those no read config invokes.

#### Scenario: A bin-wired CLI entry is not a dead-code candidate

- **GIVEN** a repository whose package.json `bin` names `dist/cli/index.js`, compiled from
  `src/cli/index.ts`, which no internal code imports
- **WHEN** `find_dead_code` runs
- **THEN** the functions in `src/cli/index.ts` are `externally-wired` roots, and the output carries the
  receipt naming package.json and the `bin` key

#### Scenario: An argument is not wiring

- **GIVEN** an npm script `eslint . --ignore-pattern src/dead.ts`
- **WHEN** the package.json adapter reads it
- **THEN** `src/dead.ts` gains no evidence and remains a candidate if nothing else reaches it

#### Scenario: Adapters never assert deadness

- **GIVEN** a file referenced by no config format and no import
- **WHEN** the adapters run
- **THEN** they contribute no evidence about it, and its candidate entry is unchanged by this feature

#### Scenario: An unresolvable reference is a disclosed boundary

- **GIVEN** an npm script invoking a file through a variable (`node $SCRIPT`)
- **WHEN** the package.json adapter parses it
- **THEN** no root is added and the result lists the reference as a `dynamic-reference` boundary

#### Scenario: A config-wired untested entry point is not also-dead

- **GIVEN** a script a workflow `run:` step executes that no test reaches
- **WHEN** `report_coverage_gaps` runs with the adapters active
- **THEN** the gap carries the adapter receipt and is not flagged `alsoFlaggedDead`
