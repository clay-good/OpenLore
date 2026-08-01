# cli spec delta

## ADDED Requirements

### Requirement: OneShotOrientCarriesTheSameStalenessDisclosure

The one-shot CLI read paths that install wires as agent hooks — `orient --json --task` and
`orient --inject` — SHALL perform the same cited-file freshness check as the MCP handlers and
carry the same staleness disclosure: in `--json` output as a payload field, in `--inject` output
as a single factual line inside the injection block (within the token budget). The check SHALL
never block, never spawn analysis from the hook, and never write to stdout outside the
JSON/injection block.

#### Scenario: A hook-driven orientation after an unindexed edit discloses staleness

- **GIVEN** a repository where a function was added to `src/payments.ts` after the last analyze
- **WHEN** the `UserPromptSubmit` hook runs `orient --inject` with a prompt matching that file
- **THEN** the emitted block includes a staleness line naming `src/payments.ts`, stdout contains
  only the block, and the hook exits 0
