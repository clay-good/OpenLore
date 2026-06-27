# mcp-handlers spec delta

## ADDED Requirements

### Requirement: AgentBehavioralGovernance

The system SHALL provide an opt-in agent behavioral governance layer that observes per-agent
behavioral destabilization and, in interventional modes, surfaces an advisory signal — computed by
deterministic runtime heuristics, never by an LLM. The layer SHALL be built on the existing
`EpistemicTracker` and reuse the EpistemicLease content-item injection surface; it SHALL NOT alter the
freshness engine (`updateTracker()`), which continues to run in all modes.

The layer SHALL be governed by a single config field `panicResponse.mode` with the ladder
`off | observe | advisory`, defaulting to `off`. In `off`, the layer SHALL perform no scoring, write no
state file, inject no signal, and emit no telemetry. `observe` SHALL score and persist state with no
agent-visible effect. `advisory` SHALL additionally inject a signal as a separate content item (never
concatenated into the result body) at level L2 and above.

All hook-facing commands (`panic-check`, `panic-level`) SHALL fail open — exit 0 on every code path,
including errors and corrupt state. The behavioral state file SHALL resolve to a stable state on
corruption. Telemetry writes SHALL pass through the existing secret-redaction path.

Interventional enforcement (a runtime block decision), the Gryph runtime-observability subsystem and
its background process, and any auto-installed agent hooks are OUT OF SCOPE for this requirement and
SHALL NOT be enabled by default; they are deferred to follow-up changes gated on validated signal
accuracy.

No interventional posture (default `advisory` injection, `experimental_blocking`, or auto-installed
hooks) SHALL ship enabled-by-default until the panic signal's accuracy is validated from `observe`-mode
telemetry on real sessions — a measured false-positive rate low enough that acting on the signal is
net-positive, plus evidence that interventions improve rather than disrupt behavior. Landing the
scoring machinery does NOT satisfy this gate. Until it is cleared, the only sanctioned modes are `off`
(default) and `observe` (silent measurement).

#### Scenario: Intervention stays gated until accuracy is validated

- **GIVEN** the behavioral governance machinery is integrated and green
- **WHEN** a maintainer considers enabling an interventional posture by default
- **THEN** it remains gated until `observe`-mode telemetry demonstrates an acceptable false-positive
  rate and net-positive intervention outcomes — the machinery being present is not itself sufficient

#### Scenario: Default off has zero behavioral footprint

- **GIVEN** a project with no `panicResponse.mode` set (or `mode: 'off'`)
- **WHEN** an agent makes MCP tool calls
- **THEN** no panic scoring runs, no `panic-state.json` is written, no signal is injected, and no panic
  telemetry is emitted — only the existing EpistemicLease freshness behavior occurs

#### Scenario: Advisory injects without corrupting structured output

- **GIVEN** `mode: 'advisory'` and an agent whose behavioral score has reached L2
- **WHEN** a tool returns a structured (JSON) result
- **THEN** the panic signal is appended as a separate content item and the result body remains valid,
  unmodified JSON

#### Scenario: Hook consumer fails open

- **GIVEN** a corrupt or missing `panic-state.json`
- **WHEN** `openlore panic-check` runs as a PreToolUse hook
- **THEN** it resolves to a stable state and exits 0, never blocking the tool call

### Requirement: BehavioralObservabilityToMemory

The system SHALL provide a deterministic observe→memory feedback loop that turns behavioral telemetry
into a durable, code-anchored signal about where agents destabilize. `openlore panic-hotspots` SHALL
aggregate epistemic-lease telemetry per module into labeled hotspots (deep-stale / high-oscillation /
cross-module-drift), with no LLM and no composite score, and `--write` SHALL persist them to
`.openlore/analysis/behavioral-hotspots.json`. `orient()` SHALL consume that artifact and surface a
contextual `behavioralHotspots` block when the task's files intersect a labeled hotspot module. The
surfacing SHALL be fail-open, omitted in lean mode, and gated on `panicResponse.mode != 'off'` so a
pre-existing artifact never leaks when the panic subsystem is disabled.

The accuracy gate (`openlore panic-validate`) SHALL report deterministic evidence — false-positive
proxy with per-trigger attribution, peak-level histogram, intervention follow-through, and pass/fail
criteria — with a verdict of `INSUFFICIENT_DATA` or `REVIEW_REQUIRED`, never auto-`CLEARED`. A
`--strict` flag MAY exit non-zero for automation when the criteria are not met.

#### Scenario: orient surfaces a hotspot only when contextual, labeled, and panic is enabled

- **GIVEN** a persisted `behavioral-hotspots.json` with a labeled `auth` hotspot and `mode: 'observe'`
- **WHEN** `orient()` runs for a task whose files are in the `auth` module
- **THEN** the result includes a `behavioralHotspots` entry for `auth`; and the same call with
  `mode: 'off'`, a missing artifact, an unlabeled module, or `lean` mode SHALL omit it

### Requirement: PanicSignalAccuracyValidation

The system SHALL provide deterministic, in-code measurement of the panic signal's accuracy as the
complement to real observe-mode telemetry. A replay capability SHALL drive the real behavioral engine
(updateTracker / updatePanic / resetPanicOnOrient) over a recorded or synthetic trace of
`(tool, filePath, gapMs)` steps under a virtual clock, producing the same result every run. A
calibration capability SHALL measure the false-positive rate and sensitivity at the L2 intervention
threshold against a labeled ground-truth corpus (coherent vs. confused traces). Known over/under-
sensitivities SHALL be documented and regression-pinned rather than silently altered. The engine clock
indirection SHALL default to `Date.now()` so production behavior is unchanged.

`openlore panic-replay` and `openlore panic-calibrate` SHALL be read-only and exit 0 by default;
`--strict` MAY exit non-zero when discrimination on the clear-cut corpus regresses (for CI). None of
this lowers the gate: enabling an interventional posture by default remains a human decision grounded
in real observe-mode data.

#### Scenario: the engine discriminates coherent from confused behavior

- **GIVEN** the labeled calibration corpus replayed through the real engine
- **WHEN** discrimination is measured at the L2 threshold
- **THEN** no coherent trace trips L2+ (0% false positives) and every confused trace does (full
  sensitivity); a documented over-sensitivity is reported as evidence, not hidden
