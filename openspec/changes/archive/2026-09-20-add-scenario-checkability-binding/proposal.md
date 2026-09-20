# Scenario checkability and test binding: from "requirement has code" to "scenario has a verification path"

> Status: PROPOSED (2026-07-27, field research sweep — `FIELD-RESEARCH-2026-07.md`). Two
> additive checks on the spec corpus: a deterministic shape lint that says whether a scenario is
> *checkable* (well-formed condition/behavior structure), and a graph binding that says whether
> a checkable scenario *has a verification path* (a test reaching its requirement's anchored
> symbols). Prior art: the requirements-syntax tradition (EARS-style templated criteria) that
> the spec-driven-development ecosystem converged on precisely because well-shaped criteria map
> ~1:1 onto tests; the borrow is the well-formedness *grammar check*, not any authoring tool or
> template library.

## The gap

- `audit_spec_coverage` answers "does this requirement have implementing code?" and the open
  `adopt-spec-link-status-vocabulary` proposal refines *link status* (unwanted/predated).
  Neither answers the question a verifier actually needs first: **is this scenario even
  checkable, and if so, does any test verify it?** A scenario reading "THEN it works well" has
  code coverage and link status and is still worthless as an acceptance criterion.
- OpenLore's own corpus history proves the cost: the 2026-07-27 repair pass hand-fixed 39
  requirements whose scenarios were missing entirely, and the decision syncer emitted them
  (recurrence fix proposed as `fix-decision-sync-template-validity`). Shape validity is now
  enforced (`openspec validate`), but *checkability* — a THEN that asserts something
  observable — is not, and scenario→test binding does not exist at all.
- Both halves are deterministic compositions of shipped machinery: the scenario parser exists,
  the requirement→symbol anchor exists (`mapping.json` + `> Implementation:`, made
  graph-checked by the open `ground-generated-specs-in-the-graph` proposal — a
  makes-better-not-blocks dependency), and backward test reachability exists (`select_tests`).

## What changes

- **A scenario-checkability lint** (in the corpus-lint lane, plus surfaced by
  `audit_spec_coverage`): a closed grammar check per scenario — has at least one WHEN (or
  GIVEN+WHEN) establishing a condition, at least one THEN, and the THEN clause names an
  observable subject (a quoted literal, a tool/command name, a symbol, a field, or a
  numeric/comparative outcome — a closed token-class list, not a semantic judgment). Failures
  emit the registered advisory finding `scenario-unverifiable-shape` with the failing clause
  quoted. This is a *shape* lint: it never judges whether the scenario is semantically right,
  and it never blocks (advisory default, opt-in blocking via `enforcement.policy` like every
  finding).
- **Scenario→test binding in `audit_spec_coverage`:** for each requirement with a resolvable
  symbol anchor, compose the existing backward test reachability to label each of its scenarios
  `verification-path-exists` (≥1 test reaches an anchored symbol; the tests named) or
  `no-reaching-test`; a requirement with no resolvable anchor labels its scenarios
  `not-assessable` with the reason (no anchor / anchor unresolved). The label vocabulary is
  closed and the sound direction is stated: `verification-path-exists` means a path exists,
  NEVER that the test asserts the scenario's behavior — the response says so verbatim
  (the same reachable-≠-verified honesty `report_coverage_gaps` ships).
- **Deliberately NOT borrowed / NOT built:** test generation; LLM judging of scenario
  semantics; runtime test execution or result parsing; a requirements-authoring template
  DSL (the lint checks the existing scenario format, it does not impose a new one); link-status
  vocabulary (sibling `adopt-spec-link-status-vocabulary` owns unwanted/predated — named, not
  duplicated); requirement→symbol anchoring itself (sibling `ground-generated-specs-in-the-graph`
  owns the anchor's fidelity — this change consumes whatever anchor resolution exists).

## Why this is in scope

The governance face's spec corpus is only as strong as its weakest scenario, and the project has
already paid a 39-requirement repair bill for unchecked scenario quality. Both additions are
deterministic, additive, advisory-first, and composed from shipped machinery; together they
upgrade `audit_spec_coverage` from a presence check to a verifiability audit — the deterministic
core of what the SDD field calls executable specifications, with no LLM and no execution.

## Impact

- Files: the checkability grammar in the spec parser/lint lane, one `FINDING_CODE_REGISTRY`
  entry, scenario labeling in the `audit_spec_coverage` handler (composing `select_tests`
  reachability), docs.
- Specs: `openspec` — 1 ADDED requirement; `mcp-handlers` — 1 ADDED requirement.
- Tool surface: no new tool; additive per-scenario labels on one existing tool; one advisory
  finding code.
- Risk: a shape lint misread as a semantic guarantee (mitigated: the verbatim sound-direction
  sentence in both surfaces); noisy findings on legacy corpora (mitigated: advisory default;
  composes with the open `add-enforcement-baseline-ratchet` `frozen` class for brownfield
  adoption); anchor quality bounding binding quality (disclosed: `not-assessable` carries the
  anchor reason, and improves automatically as the grounding sibling lands).
