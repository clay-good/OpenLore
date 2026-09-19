# Public-surface acceptance baseline and consumer-weighted verdicts

> Status: BUILT (2026-09-19, PR #519). Split out of `refine-public-surface-certification`, whose rule
> codes, suggested bump, and findings shipped in PR #498. Design history and prior art are in the
> archived proposal `openspec/changes/archive/2026-09-13-refine-public-surface-certification/proposal.md`
> (parts 2 and 3).

## The gap

- An intentional, shipped breaking change re-reported on every `certify_public_surface` run against
  the same base; there was no acceptance path.
- A breaking change with zero indexed consumers read the same as one with forty, and sibling
  repositories under federation were not checked.

## What changes

1. **Accepted-breakage baseline, justification required.** `certify-public-surface --base <ref>
   --accept --justification "<why>"` records the diff's breaking findings in
   `.openlore/public-surface-baseline.jsonl`: one sorted entry per rule code + subject + discriminator
   (which break: the canonical before/after contract, the removed declaration, or the rename target),
   a required justification, and an optional decision id. Diff mode lists matched findings as
   `accepted` and leaves them out of `findings[]`; an acceptance whose decision is superseded,
   rejected, or unknown is `stale` and the finding reports again. `.gitignore` is never edited; the
   command prints `git add -f` when Git would ignore the file.
2. **Consumer-weighted verdicts.** Each breaking change carries `breakingClass`:
   `breaking-consumed` (consumers listed, each with how it binds) or `breaking-unconsumed-in-index`.
   The in-repo census uses resolved calls, the dependency graph's imports (aliases resolved, through
   barrels), whole-module imports, and unresolved calls to a removed name. The `federation` input
   adds consumers in indexed sibling repos via `findCrossRepoConsumersBatch`.

## Deliberately not in scope

- Return-type compatibility direction in the classifier (filed separately).
- Resolving imports the analyzer does not resolve (for example Python absolute imports in a src
  layout); the census discloses them instead.

## Impact

- Files: `src/core/services/mcp-handlers/public-surface.ts`,
  `src/core/services/mcp-handlers/public-surface-baseline.ts` (new),
  `src/cli/commands/certify-public-surface.ts`, `src/core/federation/resolver.ts` (per-symbol
  truncation), `claim-verification.ts` (shared decision-store read), tests, docs.
- Specs: `mcp-handlers` — 2 ADDED requirements (AcceptedBreakageBaselineRequiresJustification,
  ConsumerWeightedBreakingVerdicts).
