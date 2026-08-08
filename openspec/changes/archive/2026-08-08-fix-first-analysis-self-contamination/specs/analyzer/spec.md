# analyzer spec delta

## ADDED Requirements

### Requirement: ToolAuthoredArtifactsDoNotSkewRepoCharacterization

The analyzer SHALL exclude files that are entirely OpenLore-managed — identified by OpenLore's
own managed-file fingerprints (`_openlore.managed` in JSON artifacts, the managed-block
fingerprint in generated Markdown), never by a hardcoded filename list — from domain clustering,
language ranking, and high-value/key-file selection. A user file that merely contains a managed
block (e.g. a `CLAUDE.md` with real user content plus the OpenLore block) SHALL still count as a
user file. Excluded files MAY still appear in file inventories, labeled as tooling.

#### Scenario: Install then analyze does not report OpenLore's own files as a domain

- **GIVEN** a clean repository where `openlore install` has just written `.mcp.json` and
  `AGENTS.md` and appended a managed block to `CLAUDE.md`
- **WHEN** the install-triggered analysis runs
- **THEN** no detected domain's membership is dominated by the install-authored files, and the
  reported top languages are computed over user files only

#### Scenario: A real user AGENTS.md still counts

- **GIVEN** a repository whose `AGENTS.md` contains user-authored content outside any managed
  block
- **WHEN** the repository is analyzed
- **THEN** that file participates in characterization as a user file

### Requirement: DomainNamesAreNeverDerivedFromDotfileCoincidence

A suggested domain name SHALL be a well-formed identifier (leading character alphanumeric). The
first-file-name fallback SHALL NOT produce a name from a dotfile or yield a name that depends on
scan order; a cluster of root-level configuration files with no structural edges SHALL receive an
honest fixed label (e.g. `(root config)`) rather than a name borrowed from whichever file came
first.

#### Scenario: A root config cluster is labeled honestly

- **GIVEN** a repository whose root contains `.mcp.json`, `package.json`, and `.gitignore` with
  no import edges among them
- **WHEN** clusters are named
- **THEN** the cluster's suggested domain is the fixed root-config label, and no suggested domain
  in the artifact begins with a non-alphanumeric character

### Requirement: EveryAnalyzedSourceFileIsDomainedOrDisclosed

Every file that contributes call-graph nodes SHALL either belong to a domain in the repo
structure artifact or be listed in an explicit undomained disclosure in that artifact. A source
file SHALL NOT be silently absent from the domain view.

#### Scenario: A lone script outside the clustered directories is disclosed

- **GIVEN** a repository with `scripts/report.py` containing two functions, where clustering
  produces no domain covering `scripts/`
- **WHEN** the repository is analyzed
- **THEN** `repo-structure.json` either assigns `scripts/report.py` to a domain or lists it in
  the undomained disclosure
