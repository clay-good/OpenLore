# analyzer spec delta

## ADDED Requirements

### Requirement: WorkspaceShardsAreDetectedDeterministicallyAndAssignmentIsTotal

The analyzer SHALL detect workspace shards from package manifests already present in the
repository — npm `workspaces`, the pnpm workspace file, yarn workspaces, Cargo workspace members,
Go modules, Python project files, and Gradle/Maven module declarations — and SHALL represent each
detected package as a named shard with a declared root and file set. Detection SHALL be
deterministic in membership and ordering, SHALL be reported, and SHALL be overridable by
configuration.

**Assignment SHALL be total.** A file matching more than one shard root SHALL be assigned to the
most specific root, regardless of ecosystem. A file matching **no** shard root SHALL be assigned
to an implicit **root shard** — nameable, recomputable, and reported with its file count. No
analyzed file SHALL be unassigned, and no file SHALL be excluded from analysis by virtue of shard
detection.

The reported shard list SHALL name the manifest each shard was derived from, since declared
membership (npm, Cargo) and per-package presence (`go.mod`, `pyproject.toml`) are different
detection rules whose overlap must resolve visibly. A declared workspace member resolving outside
the repository root SHALL be reported and ignored, never walked. Shard membership SHALL be
applied **after** the existing include/exclude patterns, so shards partition the existing corpus
and can never widen it.

A repository with no detectable manifests SHALL resolve to exactly one shard, and its analysis
SHALL be byte-identical to the analysis produced before shards existed.

#### Scenario: A workspace monorepo resolves to its packages plus a root shard

- **GIVEN** a repository whose root manifest declares three workspace packages, plus root-level
  `scripts/` and config files belonging to none of them
- **WHEN** the repository is analyzed
- **THEN** four shards are reported — the three packages and the root shard — every source file
  is assigned to exactly one, and each shard names the manifest it came from

#### Scenario: A single-package repository is unchanged

- **GIVEN** a repository with no workspace declaration
- **WHEN** it is analyzed
- **THEN** exactly one shard is reported and the graph is byte-identical to the pre-change graph

#### Scenario: A member outside the root is refused, not walked

- **GIVEN** a workspace declaring a member resolving above the repository root
- **WHEN** shards are detected
- **THEN** the member is reported and ignored, and the walker never descends outside the root

### Requirement: ShardScopedAnalyzeConvergesOverTheWholeGraphOrMarksStale

A shard-scoped analyze SHALL recompute the named shards' files and SHALL re-resolve the
**cross-shard resolution frontier**, defined as the union of:

1. every stored edge whose caller or callee lies in a recomputed shard, including edges whose
   callee is a synthetic external leaf;
2. every file **outside** the recomputed shards holding a previously-external call site whose
   bare callee name the recompute **adds** as an internal definition; and
3. every file outside the recomputed shards holding a name-only-resolved call site whose callee
   name's set of internal definitions the recompute **changes in multiplicity** — an addition
   making a unique name ambiguous, or a removal making an ambiguous name unique — regardless of
   which shard the current callee lies in.

Classes (2) and (3) SHALL be derived from the symbol names the recompute adds and removes, diffed
against the stored pre-recompute name set; they are not expressible from the stored edge set and
SHALL NOT be omitted. This is the same bounded expansion the incremental watcher already performs
under the shipped converge-or-flag requirement, applied at shard granularity, and SHALL reuse
that machinery rather than introduce a second closure rule. Re-resolution SHALL seed the resolver
with all stored internal nodes, so a call into a shard that was not recomputed never degrades to
an external edge.

**Equivalence is asserted over the whole repository, not over the scope.** The graph produced by
a shard-scoped analyze SHALL equal the graph a full rebuild would produce over the entire
repository, except for regions explicitly marked stale: every symbol, edge, and overlay record
that differs SHALL lie inside an explicitly-marked stale region. The scoped analyze MAY over-mark;
it SHALL NOT under-mark. Scoping the equivalence obligation to the same frontier function it is
meant to constrain would make it vacuously satisfiable and is not permitted.

Where the frontier expansion cannot complete within its work budget, the remainder SHALL be
marked stale using the existing stale-region machinery and vocabulary rather than a second
staleness concept. A shard-scoped analyze SHALL NEVER silently narrow the graph by dropping
symbols, edges, or overlay records belonging to shards it did not recompute.

**Freshness SHALL be recorded per shard.** A shard-scoped analyze SHALL NOT write a
repository-wide freshness fingerprint asserting currency for shards it did not recompute, and
SHALL NOT be recorded as a full analyze for epistemic-lease purposes. Retained shards outside the
bounded resolution frontier SHALL report freshness as unknown without rereading their source files;
a retained frontier file found to have changed SHALL be reported stale, not current.

Every shard-scoped analyze SHALL report the shards recomputed, the shards retained with their
last-recomputed state, the frontier size, and any region marked stale.

#### Scenario: A symbol added in one shard rebinds an unresolved call in another

- **GIVEN** package `a` contains a call resolving to an external leaf, and a change to package
  `b` adds a definition of that name
- **WHEN** `b` is analyzed shard-scoped
- **THEN** the edge from `a` binds to `b`'s definition, matching a full rebuild — even though no
  stored edge touched `b` — or `a`'s file is explicitly marked stale

#### Scenario: An ambiguity flip outside both shards is caught

- **GIVEN** a call in shard `a` uniquely resolved to a definition in shard `c`, and a recompute
  of shard `b` adds a second definition of that name
- **WHEN** `b` is analyzed shard-scoped
- **THEN** the now-ambiguous edge is withdrawn to match a full rebuild, or the affected file is
  marked stale

#### Scenario: Scoping never amputates the graph

- **GIVEN** a repository where package `c` is not recomputed
- **WHEN** a scoped analyze of package `b` completes
- **THEN** `c`'s symbols and edges are still present, and no call from `b` into `c` has been
  downgraded to an external edge merely because `c` was not recomputed

#### Scenario: A scoped analyze does not declare the repository fresh

- **GIVEN** a 40-package repository with one package recomputed
- **WHEN** freshness is evaluated
- **THEN** the 39 retained shards report their own last-recomputed state, and no repository-wide
  fingerprint asserts they are current

### Requirement: ShardScopedAnalyzeIsNonDestructiveAndPartialityIsDisclosedInEveryArtifact

A shard-scoped analyze SHALL NOT use the full-rebuild write path, which clears the store
unconditionally. It SHALL replace only the records belonging to the recomputed shards and the
resolution frontier, leaving all other stored rows byte-identical, and SHALL do so under the same
single-writer lock and atomicity guarantee a full rebuild uses — two concurrent shard-scoped
analyzes SHALL NOT interleave into a torn graph.

Every repository-wide derived artifact — the architecture digest, repo-structure and
llm-context artifacts, the dependency graph, parse-health, the keyword corpus, the repository
vocabulary lexicon, the dynamic-boundary sidecar, the vector index, and the text-line index —
SHALL be either re-aggregated over the **persisted whole-repository graph** or retained unmodified
and reported as retained. A shard-scoped analyze SHALL NOT rewrite a repository-wide artifact
from a shard-local input, and the report SHALL state which artifacts were recomputed and which
were retained.

The index attestation SHALL remain valid over the whole graph after a partial write: counts SHALL
be reconciled against the live store and the content digest SHALL be recomputed or explicitly
invalidated. An attestation SHALL NOT reconcile as healthy over a graph narrowed by a partial
write. An index carrying explicitly-stale shards SHALL NOT be exportable, bundleable, or
importable as a complete index.

#### Scenario: Repository-wide artifacts are not narrowed to one shard

- **GIVEN** a three-package repository whose architecture digest describes all three
- **WHEN** one package is analyzed shard-scoped
- **THEN** the digest still describes all three, the keyword corpus and lexicon are not rebuilt
  from one shard's input, and the report names what was recomputed and what was retained

#### Scenario: A narrowed graph never attests healthy

- **GIVEN** a shard-scoped write that recomputes one of forty packages
- **WHEN** the attestation is reconciled on the next load
- **THEN** it reflects the whole-graph state and does not report healthy over a narrowed index
