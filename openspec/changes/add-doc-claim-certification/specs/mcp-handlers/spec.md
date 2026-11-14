# mcp-handlers spec delta

## ADDED Requirements

### Requirement: ChangeVerificationReportsDocClaimsTheDiffMadeFalse

`verify_change` SHALL check local Markdown claims the diff can break, from a closed, syntactic set:
a backticked name of exactly one indexed symbol, a local path or relative link target, and a
`path:line` citation. A claim that held at the merge-base and is false in the working tree SHALL be
reported as the advisory finding `doc-claim-refuted`, with the doc file and line and the evidence.
A symbol that was renamed or moved SHALL be reported as renamed with its current name. An ambiguous
or external subject SHALL be counted as unverifiable and SHALL NOT be reported as refuted. The check
SHALL use no model, SHALL read local files only, and SHALL NOT add a tool.

#### Scenario: A deleted function leaves a false doc line

- **GIVEN** a README line that names a function in backticks, and a diff that deletes the function
- **WHEN** `verify_change` runs
- **THEN** a `doc-claim-refuted` finding names the README line and states that the symbol is gone

#### Scenario: A rename is reported as a rename

- **GIVEN** a doc that names a symbol the diff renamed
- **WHEN** `verify_change` runs
- **THEN** the finding gives the current name, not "missing"

#### Scenario: An old error the diff did not cause is not reported

- **GIVEN** a doc claim that was already false at the merge-base
- **WHEN** `verify_change` runs on a diff that does not touch its subject
- **THEN** no finding is emitted for that claim

### Requirement: DocCurrentClaimKind

`verify_claim` SHALL accept the kind `doc-current`, whose subject is a local Markdown path with an
optional line. It SHALL return `holds` when every checkable claim there resolves, `refuted` with
each false claim and its evidence, and `unverifiable` when there is no checkable claim or the file
cannot be read.

#### Scenario: A stale line citation is refuted

- **GIVEN** a doc that cites `src/a.ts:400` when the file now has 120 lines
- **WHEN** `verify_claim` runs with kind `doc-current` on that doc
- **THEN** the verdict is `refuted` and names the citation and the current file length

#### Scenario: Another project's path is not refuted

- **GIVEN** a doc line that names only a path in another project
- **WHEN** `verify_claim` runs with kind `doc-current` on that line
- **THEN** the verdict is `unverifiable`
