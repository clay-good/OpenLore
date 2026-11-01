# mcp-handlers spec delta

## ADDED Requirements

### Requirement: EnvImpactNamesIacDeclarationSites

`analyze_env_impact` SHALL report, in `declaredBy`, each infrastructure site in the repository that
sets the variable — Kubernetes container `env`, compose `environment`, Dockerfile `ENV`, Terraform,
OpenTofu, or CloudFormation function environment maps, ECS container definitions, GitHub Actions
`env` — with ecosystem, resource, file, line, and whether a literal value is present. No value SHALL
appear in any output. A source whose keys cannot be listed (`envFrom`, `env_file`, an expression)
SHALL be listed as an opaque source, and a variable no file sets SHALL be `undeclared-in-corpus`,
with the boundary that runtime injection and external secret stores are not visible.

#### Scenario: Manifests that set a variable are named

- **GIVEN** `DATABASE_URL` read in `src/db.ts`, set in a Kubernetes Deployment and in
  `docker-compose.yml`
- **WHEN** `analyze_env_impact` runs for `DATABASE_URL`
- **THEN** `declaredBy` lists both sites with file and line, and no output contains either value

#### Scenario: A variable no file sets

- **GIVEN** a variable read in code and set by no file in the repository
- **WHEN** `analyze_env_impact` runs for it
- **THEN** it is `undeclared-in-corpus`, and the boundary says it may be set at runtime

### Requirement: BlastRadiusNamesManifestsStillSettingARemovedRead

`blast_radius` SHALL list, in `envDeclarations`, each env var a changed code file read at the base
and that no code file in the working tree reads, with the infrastructure sites that still set it. A
name still read in another file SHALL NOT be listed.

#### Scenario: A code rename shows the stale manifests

- **GIVEN** a diff that renames the read of `DATABASE_URL` to `DB_URL`, and two manifests that set
  `DATABASE_URL`
- **WHEN** `blast_radius` runs on the diff
- **THEN** `envDeclarations` lists `DATABASE_URL` with both manifest sites
