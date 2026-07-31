# Line provenance evidence: who wrote this symbol — human or agent — joined to the graph

> Status: PROPOSED (2026-07-27, field research sweep — `FIELD-RESEARCH-2026-07.md`). Ingest the
> emerging vendor-neutral line-attribution record format (Agent Trace, https://agent-trace.dev/ —
> JSON records binding code ranges to the human/agent/model/session that produced them, stored in
> git notes or sidecar files) and project it onto the symbol graph, so structural conclusions can
> carry an authorship dimension. The join is the whitespace: attribution tooling exists, call
> graphs exist, and nothing connects them.

## The gap

- OpenLore's provenance is commit- and file-granular: `get_change_coupling` mines co-change and
  churn, and the proposed knowledge-map work mines commit authorship. **Nothing records whether a
  line or symbol was produced by a human or by an agent** — the one provenance question 2026
  engineering organizations actually ask ("this 75-fan-in hub: who wrote it, and did a human ever
  review it?").
- Commit-level attribution is contested ground (`Co-Authored-By` trailers are being reverted and
  replaced ecosystem-wide); the durable direction is **line-range attribution records** that
  survive rebase/squash because they are re-mapped by VCS math, not trailer conventions. Several
  agent harnesses already emit these records. OpenLore, which owns the symbol spans those ranges
  land in, is the natural consumer — and today it discards them.
- Downstream, the measurement everyone wants (post-merge rework rate on agent-authored code vs
  human-authored — the gap the DORA 2025 report names) is a deterministic join of attribution ×
  the churn mining OpenLore already ships. Without the ingest, that conclusion is impossible.

## What changes

- **Ingest, never infer.** `openlore analyze` (and the watcher) reads attribution records when
  present — a git notes ref or `.agent-trace/` sidecar files in the repo — and projects line
  ranges onto the persisted symbol spans, producing a per-symbol `authorship` fact:
  `{ human | agent | mixed | unknown, coveredLines, totalLines, lastAgentRecord? }`. A symbol with
  no covering record is `unknown` — attribution is NEVER derived from commit trailers, author
  emails, or heuristics. Absent records = no behavior change anywhere.
- **Surfaced as a dimension on existing conclusions, not a new tool.**
  - `blast_radius` and `briefing_since` label each symbol's authorship, so "the surprising change
    is to an agent-authored hub" is visible in the briefing.
  - `report_coverage_gaps` cross-labels a gap that is also agent-authored (`agent-authored` +
    `no reaching test` is the compound risk reviewers triage first).
  - A registered advisory finding `unreviewed-agent-hub`: a symbol the existing landmark
    classifier already labels a hub whose covered lines are all agent-attributed and none
    human-attributed. No new threshold — hub comes from the shipped classifier, "all/none" is a
    set predicate, not a tuning constant.
  - `verify_claim` gains an `authored-by` kind (subject = symbol): confirmed/refuted against the
    projected facts, with the record coverage stated in the receipt.
- **Honesty contract.** Attribution records are *claims by the emitting harness*, not verified
  identity: every surfaced authorship carries `basis: "attribution-records (unverified)"` unless
  the record set is attested (composes with `add-attested-governance-artifacts`, which is not a
  dependency). Partial coverage is disclosed per symbol (`coveredLines/totalLines`); a
  line-mapping failure after a history rewrite degrades that symbol to `unknown`, never to a
  guess.
- **Deliberately NOT borrowed / NOT built:** commit-trailer parsing (contested, lossy under
  squash); any `git blame`-style reimplementation of history re-mapping (records are consumed at
  the revision they were mapped to by the emitting tool); LLM classification of "does this diff
  look agent-written"; agent identity verification (out of scope — records are disclosed as
  unverified); any UI; any write of attribution records (OpenLore only reads).

## Why this is in scope

The substrate already answers "what is this symbol connected to" and "when did it change"; "who
produced it" is the third provenance axis, computable by a deterministic projection of an open
record format onto spans OpenLore already persists — no LLM, no network, fail-soft to `unknown`.
It strengthens governance conclusions (review prioritization, coverage triage) without a new
capability family, and it positions the substrate as the join point nobody else occupies.

## Impact

- Files: a small attribution-record reader (git notes ref + sidecar discovery, tolerant parse),
  span projection in the analyze pipeline persisting a sidecar fact table, surfacing in
  `blast-radius`/`briefing-since`/`coverage-gaps` handlers, one `FINDING_CODE_REGISTRY` entry,
  one `verify_claim` kind; fixtures with synthetic record files.
- Specs: `analyzer` — 1 ADDED requirement; `mcp-handlers` — 1 ADDED requirement.
- Tool surface: no new tool; additive fields on existing conclusions; one new advisory finding
  code; one new `verify_claim` kind.
- Risk: record-format drift (mitigated: tolerant parse, unknown-on-malformed, format version
  disclosed); over-trusting unverified records (mitigated: the `unverified` basis is mandatory in
  every surfaced conclusion); rebase drift between record revision and working tree (mitigated:
  records are joined via content-hash/span freshness — a stale mapping degrades to `unknown`).
