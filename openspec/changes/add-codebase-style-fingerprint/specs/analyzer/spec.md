# analyzer spec delta

## ADDED Requirements

### Requirement: EmpiricalStyleFingerprint

The system SHALL compute a deterministic, descriptive **style fingerprint** of a repository during the
existing AST analysis pass, without a second parse and without any new parsing dependency. The
fingerprint SHALL be a fixed, closed set of **idiom counters** per language — each an integer tally of
the mutually exclusive syntactic choices the code actually makes (e.g. arrow vs. declared function,
ternary vs. `if`, `const` vs. `let`, `await` vs. `.then`, early-return vs. nested branch, template
literal vs. concatenation, and naming case per scope) — and SHALL be reported as **ratios with their
sample sizes**, never as bare percentages. The counter set per language SHALL be data declared
alongside the language's support registration, not hard-coded control flow, so a language with no
declared counter set contributes nothing (fail-soft) rather than producing unsound counts.

The fingerprint SHALL be **descriptive, not prescriptive**: it measures what the code is, emits no
lint diagnostic or quality judgment, and SHALL NOT blend the counters into a single composite style
score. The fingerprint SHALL be a deterministic function of the indexed AST — byte-identical across
re-analyses of a fixed repository state — and SHALL be recomputed on analysis and incrementally
updated for changed files under watch, so it never presents a stale idiom as current.

#### Scenario: Idiom counters are tallied in the existing parse pass

- **GIVEN** a repository whose functions are overwhelmingly arrow expressions using `const` bindings
  and early returns
- **WHEN** the repository is analyzed
- **THEN** the style fingerprint reports, per language, the dominant idiom for each counter with its
  ratio and the number of observations behind it (e.g. function-form arrow `0.92` over `240` samples),
  computed during the same AST walk that extracts signatures and the call graph — not a second parse

#### Scenario: The fingerprint rolls up at repository and region granularity

- **GIVEN** an analyzed repository with multiple communities/regions
- **WHEN** the fingerprint is requested
- **THEN** counters aggregate to the whole repository and to each region, and a single file's profile
  is available on request, each carrying its own sample sizes

#### Scenario: Re-analysis is byte-identical

- **GIVEN** the same repository at the same commit
- **WHEN** it is analyzed twice
- **THEN** the two style fingerprints are byte-identical

### Requirement: StyleFingerprintEvidenceFloorAndEnforcementAwareness

The style fingerprint SHALL withhold a ratio it cannot honestly assert. A counter whose total
observations fall below a fixed evidence threshold SHALL report its ratio as a null signal ("no
signal"), never as a default value or a misleading extreme; the threshold SHALL be a fixed constant,
not a caller-tunable knob. When a syntactic choice is not the author's to make because the language or
its canonical compiler/formatter enforces it (e.g. a mandated naming case for a given scope, or a
canonical formatting), the corresponding counter SHALL report a null signal rather than a tautological
ratio. Which scopes are enforced SHALL be declared per language in the language-support registration,
never inferred at runtime, so the fingerprint measures discretion actually exercised rather than
compiler-forced uniformity.

#### Scenario: A thinly-sampled idiom reports no signal

- **GIVEN** a language present in the repository in only a handful of functions, below the evidence
  floor
- **WHEN** the fingerprint is computed
- **THEN** that language's counters report a null signal rather than a ratio derived from too few
  observations

#### Scenario: A compiler-enforced choice reports no signal, not a tautology

- **GIVEN** a language that enforces a single naming case for a given scope
- **WHEN** the fingerprint is computed for that scope
- **THEN** the naming-case counter for that scope reports a null signal, because the codebase exercised
  no discretion there, rather than reporting a `1.0` ratio that merely restates the compiler rule
