# Tasks — fix-decision-sync-template-validity

## Implementation

- [x] `appendRequirement` (`syncer.ts:260+`): emit a deterministic `#### Scenario:` derived
      from the decision (or its consolidation acceptance criteria when present); keep the
      `> Decision recorded: <id>` dedupe key unchanged
- [x] Grammar-aware prefixing: apply `The system SHALL` only when the proposed requirement has
      no SHALL/MUST clause with its own subject (fixes the double-modal glitch)
- [x] Cross-domain stub writer: emit the normative deferral + pointer scenario form (the shape
      applied in the 2026-07-27 corpus repair)
- [x] Writer self-check: parse the emitted block (heading + SHALL/MUST + ≥1 scenario) before
      persisting; on failure, leave the spec unchanged and report a named per-decision error
- [x] Tests in `syncer.test.ts`: valid emission for both shapes; double-modal input; invalid
      emission never persists; dedupe unchanged for already-synced ids

## Verification

- [x] Sync a fixture decision into a copy of each previously-broken spec (`cli`,
      `mcp-handlers`, `config`, `overview`) and run `openspec validate --specs`: 15/15 stay
      green
