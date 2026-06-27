# cli spec delta

## ADDED Requirements

### Requirement: OrientInjectMode

The system SHALL provide an `--inject` mode on the `openlore orient` command that emits an
injection-shaped orientation block for a single task. The task SHALL be taken from `--task` when
present, otherwise read from the command's stdin (the prompt payload a pre-turn agent hook supplies).
The emitted block SHALL reuse the lean orientation output (Spec 27), SHALL be bounded by a documented
token budget, SHALL be clearly attributed to OpenLore, and SHALL open with a one-line statement that
it is informational and may be ignored (the same facts-not-coercion posture as the Epistemic Lease,
decision `8e95746d`). The mode SHALL be deterministic with no LLM. Any failure — missing graph, parse
error, empty match, or empty prompt — SHALL degrade to a single pointer line and exit 0, so a hook
that invokes it can never break the user's turn.

#### Scenario: Inject emits a budgeted, ignorable block for a real task

- **GIVEN** an analyzed repository and a task supplied via `--task`
- **WHEN** `openlore orient --inject` runs
- **THEN** it emits a lean, OpenLore-attributed orientation block that opens with an
  informational/ignorable framing line and does not exceed the configured token budget

#### Scenario: Inject never breaks the turn

- **GIVEN** a repository with no analysis graph
- **WHEN** `openlore orient --inject` runs from a hook
- **THEN** it emits a single pointer line indicating OpenLore is available and exits 0, emitting no
  error to the harness

### Requirement: OrientationRelevanceGate

The `--inject` mode SHALL compute a deterministic, local orientation-relevance signal from the
orientation result — the matched-function count, the fan-in / hub centrality of the matches, and
(only on the bounded semantic/hybrid score scale) the top match score — and SHALL compare it to a
documented threshold. When the signal is at or above the threshold, `--inject` SHALL emit the full
orientation block; when below it, `--inject` SHALL emit only a single pointer line. The threshold and
its inputs SHALL be documented and overridable in repository configuration, and SHALL never be
learned or LLM-derived.

#### Scenario: A weak-orientation task gates down to a pointer

- **GIVEN** a task whose graph match is sparse or low-scoring (the small/familiar/shallow case)
- **WHEN** `openlore orient --inject` runs
- **THEN** it emits only the single pointer line, not a full orientation block

#### Scenario: A strong-orientation task emits the full block

- **GIVEN** a deep task with a strong, high-fan-in graph match
- **WHEN** `openlore orient --inject` runs
- **THEN** it emits the full lean orientation block within budget

### Requirement: TaskScopedInjectionInstallWiring

`openlore install` SHALL wire, in addition to the existing whole-repo `SessionStart` orientation hook,
a task-scoped first-prompt injection hook for each agent adapter that exposes a pre-turn hook
mechanism (for Claude Code, a `UserPromptSubmit` hook running `openlore orient --inject`). The wired
group SHALL be marker-identified (`_openlore: true`) so re-running install replaces only the OpenLore
group in place — a stale OpenLore group self-heals to the current command and re-install never
duplicates it — while user-authored sibling hooks are left byte-identical. (Unlike the fingerprinted
managed paths in `CLAUDE.md` and `.mcp.json`, the marker-identified hook group carries no fingerprint
and is not hand-edit-protected: edits inside the OpenLore group are overwritten on the next install by
design.) `--uninstall` SHALL remove the group cleanly, deleting now-empty parent objects and the file
when it was OpenLore-only. `--dry-run` SHALL preview the change. Adapters with no pre-turn hook
mechanism SHALL fall back to the existing instruction block without error. The wiring SHALL preserve
the user's other configuration byte-for-byte (merge-not-clobber, decision `df27e8ef`).

#### Scenario: Install wires task-scoped injection idempotently

- **GIVEN** a project with Claude Code present
- **WHEN** `openlore install` runs, then runs again
- **THEN** a single marker-identified `UserPromptSubmit` OpenLore group is present after both runs, and
  any user-authored hooks are left byte-identical

#### Scenario: Uninstall removes task-scoped injection

- **GIVEN** a project where `openlore install` wired the task-scoped injection hook
- **WHEN** `openlore install --uninstall` runs
- **THEN** the OpenLore `UserPromptSubmit` group is removed, empty parents are pruned, and the file is
  deleted only if it held nothing but OpenLore entries

### Requirement: ContextInjectionOptOut

The system SHALL read a repository configuration switch controlling task-scoped context injection
(default: enabled), and when injection is disabled `openlore orient --inject` SHALL emit nothing and
exit 0. Disabling injection SHALL NOT affect the MCP server registration or the `SessionStart` primer.
The injected block's data SHALL never exceed the configured token budget regardless of match size
(detail lines are added only while they fit); the small fixed framing floor — the attribution header
and the task line, which must always be present for the block to be safely attributable and ignorable
— is exempt, so a pathologically small budget yields just that floor.

#### Scenario: Injection can be turned off without disabling the rest

- **GIVEN** a repository configured with context injection disabled
- **WHEN** `openlore orient --inject` runs
- **THEN** it emits nothing and exits 0, while the MCP server and SessionStart primer remain wired
