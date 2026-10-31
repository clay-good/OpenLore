# mcp-handlers spec delta

## ADDED Requirements

### Requirement: EnvImpactNamesIacDeclarationSites

`analyze_env_impact` SHALL report, in `declaredBy`, each IaC site in the analyzed corpus that sets
the variable — Kubernetes container `env`, compose `environment`, Dockerfile `ENV`, Terraform or
CloudFormation function environment maps, GitHub Actions `env` — with ecosystem, resource address,
file, and line, and whether a literal value is present. The value itself SHALL NOT be read into any
output or artifact. A variable read in code with no declaration in the corpus SHALL be listed as
`undeclared-in-corpus` with the boundary that runtime injection and external secret stores are not
visible. `blast_radius` on a diff that renames or removes an env-var read SHALL list the IaC sites
that still set the old name.

#### Scenario: Manifests that set a variable are named

- **GIVEN** `DATABASE_URL` read in `src/db.ts`, set in a Kubernetes Deployment and in
  `docker-compose.yml`
- **WHEN** `analyze_env_impact` runs for `DATABASE_URL`
- **THEN** `declaredBy` lists both sites with file and line, and no output contains either value

#### Scenario: A code rename shows the stale manifests

- **GIVEN** a diff that renames the read of `DATABASE_URL` to `DB_URL`
- **WHEN** `blast_radius` runs on the diff
- **THEN** it lists the two IaC sites that still set `DATABASE_URL`
