# Trust-calibrated context economy: cut mistakes and tokens together

> Status: FULLY IMPLEMENTED. Recall path (certificates + verified-current + budget-aware recall) shipped
> on `feat/recall-deterministic-ranking` (PR #161, v2.1.0); the honest-scorecard measurement (item 4)
> shipped in PR #168 (ADR-0018). Two scoped deviations from the original draft are recorded under
> "Implementation status" below.
> Change 3 of the memory-integrity set (`harden-memory-integrity-invariant`,
> `add-bitemporal-typed-memory-operations`). Builds directly on the authoritative-recall invariant.

## Why

OpenLore's own value scorecard is honest about a loss case: **+43% cost on small/familiar repos**
even as it saves 7–21% on large/unfamiliar ones (README, Spec 14 benchmark). The token win lands in
exactly one place — when the agent **stops re-deriving what OpenLore already guarantees.** Today it
doesn't fully stop, for a precise reason.

`recall` and `orient` return a freshness *verdict* (`fresh` / `drifted` / `orphaned`). But a verdict
is a claim, and a careful agent treats an unverifiable claim the way it should: it re-reads the
source to be sure — paying the token cost a second time. The verdict tells the agent *that* OpenLore
checked; it gives the agent nothing it can *act on* to safely skip the re-read. So OpenLore adds
context (the rent in the +43% case) without subtracting the work it was supposed to replace.

The reframe that ties this whole set together: OpenLore's job is not to *police* the agent into
trusting it, and not merely to remove the agent's excuse to hallucinate — it is to **remove the
excuse to re-derive.** A fact that arrives with a machine-checkable proof of currency is a fact the
agent can cite instead of re-read. That is where the tokens actually come back.

## What changes

1. **Grounding certificate on every fresh fact.** When `recall` / `orient` return a `fresh` memory or
   a structural fact, they SHALL attach a compact, deterministic certificate:
   `{ symbol, filePath, lineSpan, contentHash }` — the exact span and hash OpenLore already compared
   to produce `fresh`. The certificate is the *evidence* behind the verdict, not a second computation.
   With it, an agent (or a one-line deterministic check) can confirm currency without re-reading the
   file, and can cite the span when it acts.

2. **Verified-current marker → permission to not re-read.** A fact carrying a `fresh` certificate
   SHALL be explicitly marked `verified-current`, signaling that re-reading the underlying span is
   unnecessary. This is the direct token lever: it converts "OpenLore says fresh" (advisory) into
   "this span is provably unchanged since I last analyzed it; spend zero tokens re-deriving it."
   A `drifted` / `orphaned` fact carries no such marker — the agent *should* re-read those, which is
   correct behavior, not waste.

3. **Tiered, budget-aware recall.** Borrowing Letta/MemGPT's core/working/archival split but selecting
   deterministically: `recall` / `orient` SHALL accept an optional `tokenBudget` and return the
   highest grounding-density facts first — `core` (small, high-salience, `fresh`, always returned),
   then the recall-on-demand tail only as budget allows. Salience reuses OpenLore's **existing labeled
   classifiers** (hub / chokepoint / volatile); the budget is a caller-supplied cap, not a hidden
   weight. When the budget truncates the tail, the response SHALL say what was withheld (no silent cap).

4. **Measure the lever, honestly.** Extend the agent benchmark (`bench:agent`) to report re-read
   avoidance and the token delta attributable to certificates and budgeting, separated for the
   large-unfamiliar and small-familiar cases — so the +43% case is tracked, not hidden. If the small-
   repo case does not improve, the scorecard says so.

## What does NOT change

- **No LLM, no learned ranker, no new tuning constant.** The certificate is the span + hash already
  computed; `verified-current` is a boolean derived from `fresh`; salience uses existing classifiers;
  the budget is a caller input. North star (`overview/spec.md`, decision `c6d1ad07`) preserved.
- **The authoritative-recall invariant is unchanged and depended upon.** Only `fresh` facts get a
  certificate or `verified-current` marker; `drifted` / `orphaned` never do. A certificate is
  therefore never a vector for serving stale fact — it strengthens the invariant by making "fresh"
  independently checkable.
- **Conclusion-over-graph holds.** Certificates and tiers are conclusion-shaped fields on existing
  responses, not a graph to traverse. `tool-contract.ts` classification stays `conclusion`.
- **Surface stays flat.** No new tool; this rides `recall` / `orient` output fields and optional
  params (`tokenBudget`). Nothing enters `MINIMAL_TOOLS` or the default beyond what is already there.
- **Schema additive.** Certificate fields and `verified-current` are added to response payloads;
  callers that ignore them are unaffected.

## Research basis

- **Letta / MemGPT** tiered memory (core / working / archival): not everything belongs in-context at
  once; promote the few, page the rest. Borrowed as deterministic budget-aware selection.
- The set-wide principle (`openspec/changes/README.md`): the **server computes the conclusion** and
  the agent consumes it. Here the conclusion is "verified-current, here is the proof," and the agent
  consuming it can skip the verification step entirely — the in-model re-derivation that, like
  in-model graph traversal, costs tokens and invites error.

## Application to OpenLore

- The certificate reuses the per-node source span and `contentHash` from
  `add-code-anchored-memory-staleness` and `hashSpan` (`anchor.ts:26-29`) — the same span
  `get_function_body` returns. No new extraction.
- `verified-current` is a direct function of the `fresh` verdict already computed at recall.
- Tiering reuses the existing salience labels (hub / chokepoint / volatile) and the existing recall
  selection; this change adds ordering + a budget cap, not a new relevance model.
- Measurement extends the existing `bench:agent` harness; no new benchmarking infrastructure.

## Out of scope

- **A relevance/ranking model.** Selection stays the existing deterministic retrieval; this change
  governs *ordering under budget* and *trust evidence*, not which memories are relevant.
- **Per-tool token-budget auto-tuning.** The budget is caller-supplied; OpenLore does not learn it.
- **Caching or precomputing certificates across sessions** beyond what the analysis artifacts already
  persist. The certificate is cheap to recompute from existing spans.
- **Cross-repo or team context sharing.** Local-first, per repo.

## Implementation status

**Done on the recall path (branch `feat/recall-deterministic-ranking`, PR #161).** Requirements
`GroundingCertificateOnFreshFacts`, `VerifiedCurrentMarker`, and `BudgetAwareTieredRecall` are
satisfied and guarded by tests.

What landed:

- **`GroundingCertificate` type** (`src/types/index.ts`): `{ symbol?, filePath, lineSpan?, contentHash }`.
- **`AnchorContext.certificateForAnchor`** (`anchor-adapter.ts`): builds the certificate from an anchor,
  reusing the same span the freshness check hashes; `lineSpan` is computed from the node's byte offsets
  against the live file (the edge store persists offsets, not line numbers) — no schema change, no new
  extraction.
- **`recall`** (`memory.ts`): attaches `certificates` + `verifiedCurrent: true` to `fresh`, anchored
  facts when the graph is available; `drifted`/`orphaned` never carry either. Adds an optional
  `tokenBudget` that returns the highest grounding-density facts first and reports a
  `budget { tokenBudget, returned, withheld }` block plus a no-silent-cap note. Threaded through
  `tool-dispatch.ts` and the `recall` MCP tool schema.

Verification:

- **e2e** `memory.test.ts` (+5): verifiable certificate on a fresh fact (independent hash of the cited
  span equals `contentHash`), no certificate/verified-current on drifted or graph-unavailable facts,
  budget truncation reports the withheld count, no-budget returns the full set with no `budget` field.
- **Full suite green:** `vitest run src` — 185 files, 3863 passed / 2 skipped / 0 failed. typecheck +
  eslint clean.
- **Dogfood** on this repo's real graph: `recall("validateDirectory")` returns `verifiedCurrent` with
  certificate `{symbol, filePath, lineSpan:{26,29}, contentHash}` (line span matches the real function);
  `tokenBudget=1` returns core + reports 1 withheld; no budget returns the full set.

Two scoped deviations from the original draft (decision `61c2ea7d`):

1. **Budget tiering orders by grounding density (verified-current first), not the hub/chokepoint/volatile
   salience classifiers.** Pulling those classifiers into the memory path would add cross-module
   dependency for marginal gain; grounding density is a faithful, deterministic, self-contained signal.
   Salience-label ordering is noted as a future refinement. The `BudgetAwareTieredRecall` spec text is
   updated to match.
2. **`orient` is not wired** — it has no memory-recall surface today (confirmed in the
   `add-agent-onboarding-connect` work). Certificates/budget apply to `recall`; they extend to `orient`
   if/when it surfaces memory (e.g. via `add-cross-agent-intent-handoff`).

Item 4 (honest scorecard) — DONE in PR #168 (ADR-0018). `bench:agent` now captures the live tool
transcript (`--output-format stream-json`) and reports, per repo tier, the re-reads avoided, the
read-token delta the certificate lever removes, and the verified-current certificates delivered — so the
small/familiar +43% rent case is tracked, not hidden. The re-read extractor is the pure, CI-tested
`src/bench/transcript-metrics.ts`; live numbers require a paid run, the `--dry-run` exercises the
pipeline with synthetic per-tier values.
