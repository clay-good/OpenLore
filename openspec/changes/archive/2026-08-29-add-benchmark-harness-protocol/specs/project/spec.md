# project spec delta

## ADDED Requirements

### Requirement: BenchmarkHarnessIsReproducibleAndDeterministicallyScored

The project SHALL maintain a checked-in benchmark harness for preset-vs-preset comparison whose
runs are reproducible and deterministically scored: task environments pinned by repository SHA
and container image digest, the agent configuration recorded in the results artifact, and all
scores derived from independent oracles plus post-hoc metrics (tool-selection accuracy, step
counts, token cost) computed deterministically from logged transcripts — the model under test is
the subject of measurement, never a scorer. Task corpora SHALL declare expected tools and
plausible distractors by tool id, and corpus validation SHALL fail loudly when a referenced tool
id no longer exists. Benchmark runs SHALL be manual or scheduled, never part of per-commit CI;
the deterministic sub-benchmarks SHALL remain runnable without agent credentials at no cost.

#### Scenario: A logged run scores identically everywhere

- **GIVEN** a logged benchmark transcript from a completed run
- **WHEN** the post-hoc metrics are recomputed on a different machine
- **THEN** every score (selection accuracy, steps, token cost) is identical
- **AND** no scoring step invokes a model

#### Scenario: Corpus rot fails loudly

- **GIVEN** a corpus task declaring a distractor tool id that was removed from the surface
- **WHEN** corpus validation runs
- **THEN** validation fails naming the stale tool id, before any paid run starts

#### Scenario: Per-commit CI is unaffected

- **GIVEN** the benchmark harness is checked in
- **WHEN** a commit lands
- **THEN** CI runs only the existing test suite; no benchmark executes per-commit
