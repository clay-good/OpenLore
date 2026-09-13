# Refine public-surface certification: rule codes + semver bump, an accepted-breakage baseline, consumer-weighted verdicts

> Status: PROPOSED (2026-07-03, e2e audit pass 3). `certify_public_surface` classifies breaking
> changes but its evidence is prose-only, its verdicts are un-gateable, an intentional break
> re-reports forever, and a break with zero indexed consumers reads identically to one with 40.
> Three verified borrowings deepen it: stable per-rule codes + a computed semver bump
> (cargo-semver-checks/oasdiff/gorelease), a justification-required acceptance baseline
> (ApiCompat/Revapi — but anchored to the decision store), and a consumer-weighted verdict split
> (GraphQL Hive's conditional breaking changes, done statically).

## The gap

- **No stable rule identity.** Each classification emits human `reasons` strings only
  (`src/core/analyzer/public-surface.ts:244-304`). There is no per-rule code, so
  `enforcement.policy` cannot gate "block export removals but not type narrowings", and
  `certify_public_surface` emits **no registered governance finding at all**
  (`FINDING_CODE_REGISTRY`, `src/core/services/mcp-handlers/enforcement-policy.ts:81` — no
  `public-surface` source). Prior art: cargo-semver-checks' per-lint IDs with required-bump
  metadata (https://predr.ag/blog/cargo-semver-checks-2025-year-in-review/); oasdiff's ~490
  stable change IDs with ERR/WARN/INFO levels
  (https://github.com/oasdiff/oasdiff/blob/main/docs/BREAKING-CHANGES.md).
- **No version guidance.** The verdict says `breaking` but not "so bump major" — the gorelease
  computation (https://pkg.go.dev/golang.org/x/exp/cmd/gorelease) is a pure function of data the
  tool already has (`overallClass`, `public-surface.ts:307-312`; added exports at
  `mcp-handlers/public-surface.ts:519-530`).
- **No acceptance path.** An intentional, shipped break re-reports on every run against the same
  base; the only escape is not running the tool. .NET ApiCompat's CompatibilitySuppressions.xml
  (https://learn.microsoft.com/en-us/dotnet/fundamentals/apicompat/global-tool), Revapi's
  *required* per-ignore `justification` (https://revapi.org/revapi-basic-features/0.12.6/ignore.html),
  and Roslyn's PublicAPI.Shipped.txt all solved this with a checked-in acceptance file.
- **Verdict ignores consumer weight.** Every break is paired with in-repo consumers
  (`resolveConsumers`, `mcp-handlers/public-surface.ts:301-314`; pairing at `:586-593`), but the
  class is a flat `breaking` whether 0 or 40 consumers bind it. Worse, the boundary disclosure at
  `:603` claims "Under federation, indexed sibling repos are also checked" — **the handler takes
  no federation input** (`CertifyPublicSurfaceInput`, `:51-57`) and `resolveConsumers` reads only
  the local edge store, so that sentence over-promises today.

## What changes

1. **Stable rule codes + suggested bump.** Every classification carries a rule code from a closed,
   documented set — `export-removed`, `export-renamed`, `export-visibility-reduced`,
   `param-removed`, `param-required-added`, `param-became-required`, `param-type-narrowed`,
   `return-type-narrowed`, `signature-unprovable`, `export-added` — attached where each `reasons`
   string is built today (`analyzer/public-surface.ts:244-304`; changeKind sites in the handler).
   Breaking-classed codes are registered in `FINDING_CODE_REGISTRY` (source `public-surface`,
   default `advisory`, `enforcement-policy.ts:74-79`) so `enforcement.policy` gates per-rule and
   `openlore enforce` can govern them. The verdict gains `suggestedBump`: any breaking → `major`,
   else any `export-added` → `minor`, else `patch` — the gorelease computation, no constant.
   oasdiff's WARN level ("potential breaking, cannot be confirmed programmatically") maps exactly
   onto the existing `potentially-breaking` class; the mapping stays explicit — a
   `potentially-breaking` finding never silently escalates to a breaking-classed code.
2. **Accepted-breakage baseline, justification required.** `openlore certify-public-surface
   --accept` (CLI: `src/cli/commands/certify-public-surface.ts:119-126`) writes the current
   breaking findings into a checked-in, human-readable baseline under `.openlore/` — one entry per
   line: rule code + symbol + a REQUIRED justification (`--accept` without one refuses), plus an
   optional `decision=<8-char id>` anchoring the acceptance to a `record_decision` entry. A
   decision-anchored acceptance participates in the decision store's supersede lifecycle (the
   `stale-decision-reference` retirement graph; `verify_claim`'s `decision-current` kind,
   `claim-verification.ts:389-453`): a superseded decision flags the acceptance stale instead of
   suppressing forever — strictly better than a dumb suppression XML, whose entries never expire.
   Diff mode then reports only deltas beyond the baseline (matched entries listed as `accepted`,
   never dropped). **Sibling boundary:** `add-enforcement-baseline-ratchet` is the *generic*
   frozen-class ratchet over any finding code (identity = code + subject, auto-shrinking); this is
   the *surface-specific* acceptance file with required justifications and the decision lifecycle.
   They compose, sharing the code + subject identity vocabulary — never competing.
3. **Consumer-weighted verdict split.** `breaking` splits into `breaking-consumed` (≥1 indexed
   consumer; the consumer list and count are the evidence — no score) and
   `breaking-unconsumed-in-index` (zero indexed consumers). The external-consumer boundary stays
   disclosed on BOTH: zero indexed consumers is NEVER relabeled "safe" (prior art: GraphQL Hive's
   conditional breaking changes, https://the-guild.dev/graphql/hive/docs/schema-registry/management/targets —
   done statically here, no usage telemetry). Under the `federation` preset, cross-repo consumers
   count via the existing `findCrossRepoConsumersBatch` (`src/core/federation/resolver.ts:101`) —
   making the over-promising `:603` disclosure true instead of aspirational. Rule-code naming
   reserves (documented, not built) the buf-style FILE ⊃ PACKAGE ⊃ WIRE surface taxonomy
   (https://buf.build/docs/breaking/rules/) so future non-code surfaces don't force a rename.

## Why this is in scope

Pure deepening of a shipped conclusion tool — deterministic, local, no LLM, no new tuning
constant (rule codes are categorical; the bump is a total function; the split's evidence is a
consumer list). It closes a governance inconsistency (the one breaking-change source that emits no
policy-nameable finding) and converts a permanent re-report into a governed, justified, expiring
acceptance — the honesty contract applied to the tool's own output lifecycle.

## Impact

- Files: `src/core/analyzer/public-surface.ts` (rule code per classification),
  `src/core/services/mcp-handlers/public-surface.ts` (codes on changes, verdict split, federation
  consumer union, `suggestedBump`), `enforcement-policy.ts` (registered codes),
  `src/cli/commands/certify-public-surface.ts` (`--accept`, baseline filtering, bump rendering),
  a small baseline read/write module; tests for codes, bump, baseline, split.
- Specs: `mcp-handlers` — 3 ADDED requirements (PublicSurfaceRuleCodesAndSuggestedBump,
  AcceptedBreakageBaselineRequiresJustification, ConsumerWeightedBreakingVerdicts).
- Tool surface: no new tool; `certify_public_surface`'s response grows by small per-change fields
  (`ruleCode`, split class, `suggestedBump`). The tools/list payload budget
  (`src/cli/commands/mcp-presets.test.ts:581-582`, full < 88k) is unaffected.
- Risk: rule-code churn (mitigated: closed documented set, reserved taxonomy); baseline merge
  conflicts (mitigated: one sorted entry per line, same discipline as the ratchet sibling);
  consumers under-counted on a stale index (already disclosed via the existing staleness
  boundary — the split inherits it).
