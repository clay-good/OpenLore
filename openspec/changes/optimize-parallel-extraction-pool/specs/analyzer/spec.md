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
disclosed in the analyze output, neither changing any extracted fact. Because the extractors report
an unavailable grammar as an empty result rather than an error, a worker SHALL prove it can parse
before it accepts work, and SHALL relay its grammar-unavailable warnings to the parent: an
extraction lane that can produce nothing SHALL never be silently mistaken for files that contain
nothing.

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

#### Scenario: Parse health is lane-independent

- **GIVEN** a file whose grammar is unavailable or whose parse degrades
- **WHEN** it is processed by a worker
- **THEN** the parse-health accounting matches what the serial path would record for the same
  file, and a grammar-unavailable warning is reported once for the run rather than once per worker
