# analyzer spec delta

## ADDED Requirements

### Requirement: DynamicBoundarySitesAreExtractedAndPersisted

The analyzer SHALL record every source construct that performs dispatch the call-graph resolver
cannot follow — a **dynamic-boundary site** — as a persisted fact, without attempting to resolve
it. Each site SHALL carry its file path, line, the enclosing symbol (or, when no indexed symbol
contains it, an explicit UNATTRIBUTED marker), a `kind` from the closed vocabulary, a refusal
reason, and the matched evidence text.

The marker SHALL NOT claim module scope. An attribution miss means either that the construct is at
module scope OR that it sits inside something the language extractor does not model — Python's
emits no node for a dunder other than `__init__` — and the extractor cannot tell the two apart.
Naming the marker for the first case would convert an unknown attribution into a confident false
one, inside the requirement that exists to disclose unknown rather than imply absent.

Sites SHALL NOT introduce a node or edge into the call graph. Extraction SHALL reuse each file's
already-parsed tree — **no second parse**. Where a construct is not reachable from an existing
extraction query, the matcher SHALL add its own capture over that same tree; it SHALL NOT alter
any existing call query, and the emitted node and edge sets SHALL be byte-identical to a build
with the matcher disabled. The per-language traversal cost SHALL be stated and bounded rather
than asserted to be free.

Sites SHALL be part of the memoized Pass-1 fact set: they SHALL survive the content-hash fact
cache and the extraction-worker boundary unchanged, and the serialized payload version SHALL be
bumped when the site field is introduced, so no row written under an earlier format can be
reused. A cache hit SHALL NEVER yield an empty site set for a file that has sites.

Sites SHALL be emitted in a deterministic order — by file, then line, then kind — so two analyses
of unchanged sources produce byte-identical artifacts. The artifact SHALL be absent when no site
was recorded, and a repository with no site SHALL pay at most one failed read and no parse, and
receive no crossing. (Absence is only knowable by attempting the read, so "reads none" is not
achievable; what is achievable, and required, is that nothing beyond that read is spent.) The
disclosure path SHALL NOT re-read the artifact once per composed handler within a single
user-facing call.

Evidence text is untrusted input from the analyzed repository. It SHALL be credential-redacted
with the substrate's shared redaction, neutralized for terminal control sequences, and truncated
to a declared maximum length with the truncation marked — all **before persistence**, so the
artifact itself never carries a credential or a control sequence.

Extraction SHALL be fail-soft and false-negative-biased, and the per-language coverage SHALL be
declared as a capability in the language-capability registry so a language with no matcher is
reported as unsupported rather than as containing no dynamic dispatch.

#### Scenario: A reflective invocation is recorded, not resolved

- **GIVEN** a Python function containing `getattr(handler, action)()` where `action` is a
  parameter — the result INVOKED, since a bare `getattr(o, k)` reads an attribute and dispatches
  nothing
- **WHEN** the repository is analyzed
- **THEN** a site of kind `reflective-invoke` is recorded against the enclosing function, and the
  call graph contains no new edge for that call site

#### Scenario: The matcher is additive to the graph

- **GIVEN** the fixture corpus analyzed with the matcher enabled and disabled
- **WHEN** the two graphs are compared
- **THEN** every node and edge is identical, and only the site artifact differs

#### Scenario: A cached re-analyze reports the same sites

- **GIVEN** a repository analyzed twice with no source change, the second run served entirely
  from the Pass-1 fact cache
- **WHEN** the sites of both runs are compared
- **THEN** they are identical

#### Scenario: A clean repository writes no artifact and parses nothing

- **GIVEN** a repository in which no site was recorded
- **WHEN** it is analyzed and a conclusion tool is invoked
- **THEN** no site artifact is written, the disclosure path parses nothing, and no crossing is
  attached

#### Scenario: A credential in an eval string never reaches the artifact

- **GIVEN** a source line whose matched construct contains an API-key-shaped literal and an ANSI
  escape sequence
- **WHEN** the repository is analyzed and the artifact is read back
- **THEN** the stored evidence contains neither the credential nor the escape sequence, and the
  site is still recorded

### Requirement: DynamicBoundaryVocabularyIsClosedAndGroundedInSyntax

The `kind` of a site SHALL be drawn from a closed, source-declared vocabulary —
`reflective-invoke`, `computed-member`, `code-eval`, `dynamic-import`,
`metaprogrammed-definition`, `container-resolution` — covered by a test that fails when a matcher
emits a kind outside it.

A matcher SHALL be grounded in a construct's **syntactic form or a declared framework binding,
never in a bare callee name**. In particular, a `container-resolution` site SHALL be recorded only
where the receiver is bound to an identified dependency-injection container — an import from a
declared DI package, a declared decorator or annotation, or a resolution API named in the
source-declared framework table. A call to a method merely *named* `get`, `resolve`, or `make`
SHALL NOT be recorded.

The vocabulary SHALL carry a measured **density budget**: on the substrate's own repository and
on each language fixture, recorded sites SHALL NOT exceed a declared per-thousand-lines ceiling,
and a matcher that exceeds it SHALL fail the test suite rather than ship.

The refusal reason SHALL likewise be drawn from a closed, source-declared vocabulary, and SHALL
never state something the analyzer did not establish: `no-static-target` (the selector is computed
at runtime), `unresolved-external` (a literal selector naming no symbol in the index),
`resolvable-but-unbound` (a literal selector naming exactly one symbol the resolver did not bind —
its own reason, because folding it into `unresolved-external` would assert that a symbol plainly
present resolves to nothing), `ambiguous-target` (naming more than one), and
`unresolved-in-file-scope` (a record derived from a single file, which has no repository-wide
symbol table and therefore SHALL NOT claim a repository-wide absence it never checked).

The partition between a site and a recovered edge SHALL be determined by **resolution outcome,
not by argument form**. A matched construct that literal reflective resolution binds to exactly
one internal symbol SHALL yield an edge and no site; every other matched construct — including
one whose argument is a static literal that resolves to nothing, resolves ambiguously, or was
dropped by a fan-out cap — SHALL yield a site carrying its refusal reason. No matched construct
SHALL yield neither. Site emission therefore occurs **after resolution**, not during the
extraction walk.

#### Scenario: An ordinary map lookup is not a container resolution

- **GIVEN** `this.cache.get(key)` and `Promise.resolve(x)` in a file with no DI framework import
- **WHEN** the repository is analyzed
- **THEN** no `container-resolution` site is recorded for either

#### Scenario: A literal that resolves to nothing is still a boundary

- **GIVEN** `getattr(handler, "process")()` where no internal symbol named `process` resolves
- **WHEN** the repository is analyzed
- **THEN** no edge is emitted and a site of kind `reflective-invoke` IS recorded with refusal
  reason `unresolved-external`

#### Scenario: A refusal never states something that is not so

- **GIVEN** `getattr(handler, "process")()` where an internal symbol named `process` DOES exist
- **WHEN** the repository is analyzed
- **THEN** the refusal is `resolvable-but-unbound`, never `unresolved-external`

#### Scenario: Density stays within budget

- **GIVEN** the substrate's own repository and each language fixture
- **WHEN** sites are recorded
- **THEN** the site density is at or below the declared per-thousand-lines ceiling

#### Scenario: The vocabulary cannot drift

- **GIVEN** a matcher that emits a `kind` outside the declared vocabulary
- **WHEN** the test suite runs
- **THEN** the vocabulary-completeness test fails

### Requirement: DynamicBoundarySitesStayLiveOnIncrementalUpdate

The incremental update path SHALL keep the site artifact current for changed and deleted files
with the same dispatch the full build uses: a changed file's sites are re-derived and replace its
prior entries, a file whose last site is removed drops its entry, a deleted file drops its
entries, and the artifact is created when a repository that previously had no sites acquires one
and removed when the last one goes. Updates SHALL be atomic and best-effort — a failure SHALL be
disclosed, never thrown into the batch.

#### Scenario: A newly-introduced eval is disclosed without a full re-analyze

- **GIVEN** a watched repository with no sites
- **WHEN** a file is saved that introduces a `code-eval` construct
- **THEN** the next conclusion over that file discloses the site; **and WHEN** the construct is
  removed and the file saved again, the next conclusion discloses nothing
