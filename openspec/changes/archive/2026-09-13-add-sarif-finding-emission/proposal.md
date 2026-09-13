# SARIF finding emission: governance findings on the platform's native rails

> Status: PROPOSED (2026-07-27, field research sweep — `FIELD-RESEARCH-2026-07.md`). Emit the
> unified `GovernanceFinding` stream as SARIF 2.1.0 so structural findings ride code-scanning
> surfaces (security tab, per-line PR annotations, branch-protection code-scanning gates)
> instead of only the sticky comment and the exit code. SARIF is an OASIS standard schema; the
> mapping from the finding registry is nearly 1:1, and the deterministic-findings-as-SARIF
> pattern is the review-bot ecosystem's settled convention for machine-checkable signal.

## The gap

- Governance findings reach consumers today through exactly two transports: the `openlore
  review` sticky comment (human-readable Markdown) and the `openlore enforce` exit-code gate.
  Platform-native code-scanning surfaces — per-line annotations, dismissal workflows with an
  audit trail, org-level dashboards, branch-protection rules keyed on scanning results —
  consume SARIF, and OpenLore emits none.
- The shape work is already done: `GovernanceFinding` is
  `{ code, severity, source, subject, message }` with a source-declared registry
  (`FINDING_CODE_REGISTRY`) carrying per-code descriptions, and subjects resolve to symbols
  whose file:line spans the graph already stores. That is a SARIF `rule` + `result` +
  `physicalLocation`, one-to-one.
- Without SARIF, a team that wants "block merge on a `cross-actor-conflict` finding" must parse
  OpenLore's JSON in custom CI glue; with it, the same policy is a checkbox on infrastructure
  they already run.

## What changes

- **A `--sarif <path>` flag on `openlore enforce` and `openlore review`:** writes a SARIF 2.1.0
  log alongside the command's existing output (which is unchanged). Deterministic mapping:
  finding `code` → `rule.id`; registry description → rule metadata (`shortDescription`,
  `helpUri` to the docs anchor); intrinsic `severity` → SARIF `level` via a fixed table;
  `subject` → `physicalLocation` from the stored symbol span (a subject with no resolvable
  span carries a logical location only — never a fabricated line); `message` verbatim. One
  `run` object stamped with the tool name, version, and the graph fingerprint the findings
  were computed against.
- **Transport, not policy:** the enforcement class pipeline (`advisory`/`blocking`/`off`, and
  the proposed `frozen`) is untouched — every finding in the emitted set appears in the SARIF
  log regardless of class, with the resolved class recorded as a result property so a
  platform-side gate can choose its own threshold. Exit-code semantics do not change.
- **Determinism:** same findings + same graph state → byte-identical SARIF (stable ordering,
  no timestamps beyond the run stamp derived from the graph fingerprint).
- **Deliberately NOT built:** SARIF *ingestion* (reading other tools' logs is a different
  product); upload/API integration (the user's CI uploads the file — no network in OpenLore);
  any new finding, severity, or threshold; SARIF for non-finding outputs (certificates have
  their own proposed attestation lane).

## Why this is in scope

The finding registry was built so operators can name and govern findings; SARIF is the industry
socket that lets *platforms* do the same without custom glue. It is a pure serialization of
existing data — deterministic, local, additive, ~zero risk — with outsized reach: every
finding OpenLore ships today becomes visible to the review infrastructure teams already
operate.

## Impact

- Files: one SARIF serializer module (registry → rules, findings → results, span lookup), flag
  wiring on two CLI commands, a fixed severity→level table, docs; golden-file tests.
- Specs: `cli` — 1 ADDED requirement.
- Tool surface: no MCP tool; one flag on two existing commands.
- Risk: schema drift against platform validators (mitigated: golden files validated against
  the SARIF JSON schema in CI); span staleness mislocating annotations (mitigated: the
  standard staleness disclosure is carried as a run property, and unresolvable spans degrade
  to logical locations).
