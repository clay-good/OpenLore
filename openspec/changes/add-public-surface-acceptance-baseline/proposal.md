# Public-surface acceptance baseline and consumer-weighted verdicts

> Status: PROPOSED (2026-09-13). Split out of `refine-public-surface-certification`, whose rule codes,
> suggested bump, and findings shipped in PR #498. The design, prior art, and rationale are in the
> archived proposal `openspec/changes/archive/2026-09-13-refine-public-surface-certification/proposal.md`
> (parts 2 and 3).

## The gap

- An intentional, shipped breaking change re-reports on every `certify_public_surface` run against
  the same base; there is no acceptance path.
- A breaking change with zero indexed consumers reads the same as one with forty, and sibling
  repositories under federation are not checked (the disclosure now says so honestly).

## What changes

1. **Accepted-breakage baseline, justification required.** `certify-public-surface --accept` writes
   the current breaking findings (rule code + symbol + required justification, optional decision
   id) to a sorted, checked-in file under `.openlore/`; diff mode lists matched findings as
   `accepted`, and a superseded decision anchor flags the acceptance stale.
2. **Consumer-weighted verdicts.** `breaking` splits into `breaking-consumed` and
   `breaking-unconsumed-in-index`; under the federation preset, cross-repo consumers count via
   `findCrossRepoConsumersBatch`.

## Impact

- Files: `src/core/services/mcp-handlers/public-surface.ts`, `src/cli/commands/certify-public-surface.ts`,
  a small baseline read/write module, tests.
- Specs: `mcp-handlers` — 2 ADDED requirements (AcceptedBreakageBaselineRequiresJustification,
  ConsumerWeightedBreakingVerdicts).
