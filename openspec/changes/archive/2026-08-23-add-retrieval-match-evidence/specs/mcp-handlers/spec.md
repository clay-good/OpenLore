# mcp-handlers spec delta

## ADDED Requirements

### Requirement: SearchResultsCarryMatchEvidence

Every result served by `search_code`, `search_specs`, or a search-derived section of `orient` SHALL
carry a non-empty match-evidence structure stating
which field matched, which query terms matched, and the retrieval tier. The matched field SHALL be
drawn from a closed enumeration covering the symbol name, the path, the signature, the
documentation text, the body, and a dense-vector neighbourhood. Matched terms SHALL be reported in
query order in the tokenized form the matcher compared. For a dense-vector match the matched-terms
list SHALL be empty and the field SHALL state that the match was a vector neighbourhood; the system
SHALL NOT fabricate a lexical explanation for a non-lexical match.

The repository-wide aggregate corpus SHALL remain unchanged. Once the scorer selects its bounded
candidate window, it SHALL allocate each candidate's exact aggregate query-term contribution over
the fields of that scored row with the same tokenizer. It SHALL NOT build a second corpus, query the
index again, or compute an alternative ranking, and field attribution SHALL NOT change scores or
candidate order.

The lexical scorer SHALL preserve its aggregate term-frequency score and ordering while attributing
per-field contributions for bounded candidates. The field with the greatest contribution SHALL win; ties SHALL use the
fixed order `symbol`, `path`, `signature`, `doc`, `body`. Code symbols, signatures, documentation,
and bodies SHALL map directly; the language marker and file path that share the scored prefix SHALL
map to `path`. For specs, requirement-title tokens SHALL map to `symbol`, the scored spec/domain
marker to `path`, and requirement prose to `doc`. Canonical IDs and section labels SHALL remain
target/filter metadata and SHALL NOT be presented as lexical matches because the current ranker
does not score them. Literal-line search results SHALL map to `body`. Repeated
matched query tokens SHALL remain repeated and in query order.

The tier SHALL be one of `1` (lexical/BM25), `2` (hybrid fusion), or `3` (dense-only). A hybrid
candidate with a non-zero lexical contribution SHALL name its winning lexical field; a candidate
admitted only by dense retrieval SHALL name the vector field.

The evidence SHALL describe the structural match only. It SHALL NOT carry a relevance judgment,
quality score, confidence value, or any number other than the tier.

The field SHALL be additive: present result keys keep their names, types, and order, and no tool is
added or removed by this requirement. The same evidence object SHALL be emitted by the
command-line and the tool surfaces from one implementation, and a parity check SHALL fail when the
two diverge. Evidence SHALL be deterministic: the same index state and query yield byte-identical
evidence.

#### Scenario: A name-exact hit is distinguishable from a body hit

- **GIVEN** a query whose term matches one result's symbol name and another result's body text
- **WHEN** the results are served
- **THEN** the first result's evidence names the symbol field and the second names the body field
- **AND** each lists the terms that matched

#### Scenario: A vector match says so

- **GIVEN** a result surfaced by dense-vector similarity with no lexical term match
- **WHEN** the result is served
- **THEN** its evidence names the vector field and carries an empty matched-terms list
- **AND** no lexical term is attributed to it

#### Scenario: Evidence agrees with the ranking that produced it

- **GIVEN** any served result set
- **WHEN** the evidence is compared against the matcher's winning field and matched terms
- **THEN** they are equal for every result

#### Scenario: Evidence is not a verdict

- **GIVEN** any served result
- **WHEN** its evidence is inspected
- **THEN** it contains no relevance, quality, or confidence value

#### Scenario: The two faces do not diverge

- **GIVEN** the same query issued through the command-line surface and through the tool surface
- **WHEN** the evidence from each is compared
- **THEN** the two are identical

### Requirement: RetrievalMissesAreExplainedForANamedTarget

The system SHALL provide a diagnostic that, given a query, a search surface, and a discriminated
named target, reports
deterministically why that target did not surface. The reported cause SHALL be drawn from a closed
set distinguishing at minimum: the target is not in the index; the capability is unsupported for
the target's language; no query term matched any field of the target; a filter excluded it, naming
the filter and its value; it ranked below the returned results, naming its rank and the cutoff; and
the result budget truncated it.

The diagnostic SHALL require a named target. Invoking it without one SHALL be a usage error, and
the system SHALL NOT enumerate everything that failed to match.

The target kind SHALL be `symbol`, `file`, or `requirement`. A symbol MAY be scoped by file; an
unscoped ambiguous symbol SHALL return a usage error with bounded candidates. A requirement SHALL
use its canonical id. A target that surfaced SHALL return its 1-based rank and match evidence and
SHALL NOT be assigned a miss cause.

Miss causes SHALL be evaluated in this order: capability unsupported for the resolved target
language; target not indexed; filter exclusion; no matching lexical query term for a target absent
from the candidate trace; rank below the clamped requested limit within that trace; then omission
by the ordinary bounded candidate window. `cutoff` SHALL mean the clamped requested result limit.
`budget-truncated` SHALL name `candidate-window`; presentation token budgets and transport-level
response capping SHALL NOT be diagnosed because they are not observable by this retrieval trace.

The diagnosis SHALL use the same requested-limit matcher candidate window, tokenizer, and filter
path that produced the result set, never a widened or parallel ranking. The diagnostic SHALL explain existing
behavior and SHALL NOT change it: no result matches, ranks, filters, or truncates differently
because the diagnostic exists, and existing search results remain byte-identical apart from the
additive match-evidence field.

The diagnosis SHALL be deterministic and offline: the same index state, query, and target yield the
same cause, with no model, embedding-service call, or network request in the diagnostic path
beyond whatever the ordinary query itself performs.

#### Scenario: A term that matched nothing is named as the cause

- **GIVEN** a target present in the index and a query none of whose terms match any of its fields
- **WHEN** the diagnostic runs for that target
- **THEN** it reports that no query term matched any field of the target

#### Scenario: A filter that excluded the target is named

- **GIVEN** a query carrying a language filter and a target written in a different language
- **WHEN** the diagnostic runs for that target
- **THEN** it reports that a filter excluded the target and names the filter and its value

#### Scenario: An outranked target reports its rank

- **GIVEN** a target that matched the query but placed below the returned results
- **WHEN** the diagnostic runs for that target
- **THEN** it reports that the target was outranked and names its rank and the cutoff

#### Scenario: An unindexed target is not reported as a non-match

- **GIVEN** a target that is absent from the index
- **WHEN** the diagnostic runs for that target
- **THEN** it reports that the target is not indexed
- **AND** it does not report that no term matched

#### Scenario: The diagnostic refuses an open enumeration

- **GIVEN** the diagnostic invoked with a query and no named target
- **WHEN** the request is handled
- **THEN** it returns a usage error
- **AND** no corpus-wide list of non-matches is produced

#### Scenario: Diagnostics do not perturb results

- **GIVEN** a fixed corpus and query set
- **WHEN** search results are captured before and after the diagnostic capability exists
- **THEN** the result sets and their ordering are identical
