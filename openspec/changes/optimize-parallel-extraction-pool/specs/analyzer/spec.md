# analyzer spec delta

## ADDED Requirements

### Requirement: ExtractionPoolPreservesDeterministicOutput

The analyzer MAY execute Pass 1 per-file extraction on a fixed-size worker-thread pool. When it
does, workers SHALL run the same per-file extractor the serial path runs, SHALL receive the build's
own file records (path, language, and the content the build was given — never a re-read from disk,
because the build's content is authoritative and is not always what is on disk), SHALL parse with
per-worker parser instances, and SHALL return plain serializable fact objects; results SHALL be
merged strictly in the input file order so every downstream pass receives input identical to the
serial path. The pooled path SHALL produce analysis artifacts byte-identical to the serial path for
the same input. A worker failure SHALL fall back to serial extraction for the affected file(s), and
an environment where workers cannot start SHALL fall back to the serial path wholesale — both
disclosed in the analyze output, neither changing any extracted fact.

Because the extractors report an unavailable grammar as an EMPTY result rather than an error, a
worker's silence SHALL NOT be trusted until that worker has demonstrably extracted that language:
an empty result for a language the worker has not yet produced facts for SHALL be re-checked on
the serial path, and a case where the serial path then finds facts SHALL be disclosed as a lane
defect. A worker SHALL additionally prove it can parse — in a language the build actually contains
— before accepting work, and SHALL relay its grammar-unavailable warnings to the parent for
deduplicated reporting. An extraction lane that can produce nothing SHALL never be mistaken for
files that contain nothing.

The lane SHALL bound its own cost and liveness: worker startup and each per-file request SHALL have
deadlines after which the worker is retired and its file re-extracted on the serial path; worker
count SHALL be bounded per PROCESS, not per build, so concurrent builds cannot multiply the resident
worker set. Neither the pool nor the builder SHALL write to stdout — the same code path runs inside
the stdio MCP server, whose stdout is the protocol channel — so lane disclosure SHALL be returned on
the build result for the CLI to render.

#### Scenario: Pooled and serial extraction are byte-identical

- **GIVEN** a repository analyzed once with the worker pool enabled and once with
  `OPENLORE_NO_WORKERS=1`
- **WHEN** the two runs' analysis artifacts are compared
- **THEN** every artifact is byte-identical, regardless of worker completion order

#### Scenario: A worker crash never loses or alters a file's facts

- **GIVEN** a worker that crashes while extracting one file
- **WHEN** the analyze run completes
- **THEN** the affected file was re-extracted on the serial path, its facts are identical to a
  fully serial run, and the fallback is disclosed

#### Scenario: A worker that cannot parse is dropped, not trusted

- **GIVEN** a worker whose grammar bindings fail to load, so its extractor would return empty
  results without throwing
- **WHEN** the pool starts that worker
- **THEN** the worker fails its startup parse probe and is dropped from the pool, and if no worker
  comes up healthy the whole pass falls back to the serial lane, disclosed

#### Scenario: A worker that goes blind mid-run loses no symbols

- **GIVEN** a worker that passed its startup probe but returns an empty result for a language it
  has not yet extracted — the shape of a grammar that loaded on the main thread but not in that
  thread
- **WHEN** the pass completes
- **THEN** those files were re-extracted on the serial path, the graph is identical to a fully
  serial run, and the disagreement is disclosed as a lane defect rather than recorded as files
  that contain no symbols

#### Scenario: A worker that stops answering does not stall the run

- **GIVEN** a worker that neither replies nor exits — during startup, or while holding a file
- **WHEN** its deadline passes
- **THEN** the worker is retired, its file is re-extracted on the serial path, and the run
  completes

#### Scenario: Parse health is lane-independent

- **GIVEN** a file whose grammar is unavailable or whose parse degrades
- **WHEN** it is processed by a worker
- **THEN** the parse-health accounting matches what the serial path would record for the same
  file, and a grammar-unavailable warning is reported once for the run rather than once per worker
