# Requirement links say more: unwanted, predated, and shallow or deep coverage

> Priority: P2 · Not built
> Reaches the agent through: `verify_change` and `blast_radius` (drift findings), plus the existing `get_mapping` and `check_spec_drift` output and one `verify_claim` reason
> Why it helps the agent: it sees when its change touches code that a requirement covers but no test reaches, or that no requirement asks for any more.

## Problem

The spec link index (`src/core/generator/spec-link-index.ts`) gives each requirement one state:
`linked`, `ambiguous`, `unmapped`, `stale`, or `not-assessed`. Three real situations have no name:

- A decision or memory still points at a requirement that was deleted. Nothing reports it at the
  requirement level (`adr-orphaned` covers only a whole missing domain).
- A citation names a decision or requirement that is on disk but not yet in the index. Today it
  looks the same as a mistyped id.
- A requirement is `linked` to code, but no test reaches that code. It is reported the same as a
  requirement whose code is tested.

## What changes

The new words apply to any requirement source the spec link index reads. OpenSpec is the only
source today; other formats arrive with the separate change `spec-framework-neutrality` and get
the same words with no further work here.

- **`coverageDepth` on each linked requirement** in `get_mapping` output: `deep` (a test reaches
  the linked symbol), `shallow` (none does), or `not-assessed`. It reuses the test reachability in
  `src/core/services/mcp-handlers/coverage-gaps.ts`.
- **Three advisory finding codes**, registered in `FINDING_CODE_REGISTRY`
  (`src/core/services/mcp-handlers/enforcement-policy.ts`):
  - `spec-coverage-unwanted`: a decision or memory cites a requirement that no requirement source
    contains.
  - `spec-citation-predated`: a cited decision or requirement exists on disk but not in the index.
  - `spec-coverage-shallow`: the diff changes a symbol linked to a requirement that no test
    reaches.
- **Where they surface.** `check_spec_drift` emits them. `blast_radius` already composes
  `check_spec_drift`, and `verify_change` composes `blast_radius`, so both carry them with the
  proof: requirement name, source file, linked symbol, and the citing record.
- **`verify_claim`.** For `decision-current`, an id that is on disk but not indexed stays
  `unverifiable` and gains the reason `predated`, which tells the agent to re-index, not to doubt
  the id.

## What does not change

- No new MCP tool, CLI command, or preset. The five existing link states keep their names and
  meaning. `verify_claim` keeps its three verdicts.
- Findings are advisory. They block only if `enforcement.policy` names the code.
- Local only, no LLM. A repository with no spec framework has no requirements, so it gets no
  findings and no errors.
- `shallow` and `unwanted` are reported only for what the diff touches, so a quiet change stays
  quiet. `get_mapping` shows the whole picture on request.

## Limits we disclose

- `deep` means a test reaches the code. It does not mean the test checks the requirement.
- Depth is `not-assessed` when the linked symbol is in a language without test detection or call
  graph support, or when the index is stale.
- Requirements and decisions have no revision numbers. `predated` therefore means only "on disk,
  not in the index".
- `unwanted` covers citations OpenLore stores (decisions, memories). It does not find code that
  nobody asked for.

## Depends on

Shipped code only: the spec link index, `check_spec_drift`, and the coverage-gap reachability.
`spec-framework-neutrality` adds more sources later; this change does not wait for it.
