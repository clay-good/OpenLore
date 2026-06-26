# Change significance briefing: rank what changed since a ref by structural significance, for review and catch-up

> Status: SHIPPED (2026-06-26). Part of the `FEATURE-UPDATES.md` set. Adds a deterministic
> "what changed since ref X, and which of it structurally matters" briefing, ranked by **labels from
> existing classifiers** (not a new weighted score), with a surprising-change signal and an explicit
> no-silent-cap truncation receipt. One opt-in conclusion tool. No graph-schema change, no LLM, no
> clock.
>
> Delivered: pure analyzer module `src/core/analyzer/change-significance.ts` (tier labeling) +
> handler `src/core/services/mcp-handlers/briefing-since.ts` + opt-in MCP tool `briefing_since`
> (full preset) + `openlore briefing-since` CLI. Tiers are `surprising-change` (hub ∧ low-churn ∧
> history) > `hub-change` (hub ∧ orchestrator) > `chokepoint-change` (hub ∧ ¬orchestrator) >
> `ordinary-change`; the hub/chokepoint split resolves OpenLore's `chokepoint = hub ∧ ¬orchestrator`
> definition so both tiers are non-empty (see the analyzer-spec note). Changed symbols are file-
> granular (disclosed); `surprising-change` is withheld when `< 2` non-bulk commits of history exist;
> truncation always carries a receipt (omitted count + lowest tier) and never drops a higher tier.
> Tool count 68 → 69. Decision recorded at the commit gate.
>
> Review hardening (adversarial e2e + spec audit, 2026-06-26): added two honesty
> disclosures the first pass missed — (1) a **silent base-ref fallback** is now surfaced
> (`baseRefFallback` + a lead caveat) instead of quietly briefing against `main` when a
> `baseRef`/`--base` can't be resolved (new `refExists` helper in `git-diff.ts`), and
> (2) a caveat for the **file-path-exact churn join** (git history does not follow renames,
> so a just-renamed file can read low-churn and be over-flagged `surprising-change`).
> Plus a dedicated full-surface-only preset guard for `briefing_since`, a CLI-surface test,
> and `refExists` unit tests. Test count 13 → 26.
>
> Review round 3 (2026-06-26): fixed a region-scope note that misreported "nothing changed" when a
> `filePattern` matched no file, and a false `baseRefFallback` on a self-resolving base (the empty-tree
> SHA). Scoped the briefing to **hand-authored source code** — IaC resources and generated/vendored
> files are now excluded, matching the significance-ranking sibling `report_coverage_gaps`; the shared
> `isCodeNode`/`isExcludedPath` predicates were extracted to `mcp-handlers/code-node.ts` so the two
> scopes can't drift. Added a README prose feature section (sibling parity). Test count → 29.

## Why

Every change-oriented tool OpenLore has is about **your own pending diff**: `blast_radius` and
`add-preflight-blast-radius-guard` brief the edit you are about to make; `add-change-impact-certificate`
certifies it. None of them answers the other, equally common question: **"a lot changed in this repo
since I last looked — what actually matters?"** That is the question a reviewer faces on a large PR, an
engineer faces returning from two weeks away, and an agent faces when onboarding onto an active
codebase. The naive answer — the raw git diff — is a flat wall of changed lines with no sense of which
changes are load-bearing and which are noise. A 400-file diff where the one change that matters is a
modified high-fan-in function is exactly where a flat diff fails and where structure helps.

A competitor turns this into a first-class capability: given a time/commit cursor, it returns the change
set ranked by structural significance, with a notion of a *surprising* change (a normally-stable,
heavily-depended-on symbol that suddenly moved) and a budget that surfaces the minimum set covering most
of the significance rather than dumping everything. OpenLore has every ingredient already — git diff,
the call graph, the `landmark-signals` hub/chokepoint/volatile classifiers, and churn from
`get_change_coupling` — but has never assembled them into this lens. It can, and it can do it without
violating the discipline that bans composite salience scores.

## What changes

1. **A catch-up briefing keyed to a base ref.** Given a base ref (the last-reviewed commit, the PR base,
   "where I was when I left"), the system computes the changed symbols between that ref and the current
   state and returns them as a **ranked briefing**, grouped by region/community, with the tests that
   should run for the set (reusing `select_tests`).

2. **Ranking by labels, not by a new score (north-star discipline).** Changed symbols are ordered by a
   **tier of labels produced by classifiers OpenLore already has**, then by raw evidence — never by a
   blended weighted number (the prohibition set by the navigation set and carried by this set). The tiers:
   - **surprising-change** — the symbol is a hub (high fan-in, per `landmark-signals`) AND it rarely
     changed before this (low historical churn, per the change-coupling/churn signal). A normally-stable,
     widely-depended-on symbol changing is the highest-signal event; this is the deterministic analogue
     of a "change surprise" indicator, expressed as a label over two existing signals.
   - **hub-change** — a high-fan-in symbol changed.
   - **chokepoint-change** — a betweenness chokepoint changed (a change here can disconnect regions).
   - **ordinary-change** — everything else.
   Within a tier, order by raw fan-in (evidence, not a tuning constant). Each briefed symbol carries its
   labels and the raw evidence behind them (fan-in count, prior churn), so the ranking is transparent and
   the caller — not a hidden formula — makes the final judgment.

3. **A significance budget with an explicit truncation receipt (no silent cap).** The briefing surfaces
   the highest-tier changes first and bounds its size; when it truncates, it SHALL say what it dropped —
   the count and the lowest tier reached — so "here is what matters" is never silently "here is an
   arbitrary top slice." This is the `mcp-quality` no-silent-truncation requirement applied to a ranked
   set: a bounded briefing is always distinguishable from a complete one.

4. **An honest surprising-change signal.** The surprising-change label requires churn history; when the
   repository's history is too shallow to establish that a hub "rarely changed before," the label is
   **withheld** (the symbol still ranks as `hub-change`), exactly as the style fingerprint withholds a
   ratio below its evidence floor. The system never asserts a change is surprising without the history to
   support it.

5. **One opt-in MCP conclusion tool, `briefing_since`** (and a CLI equivalent). Input: a base ref (and
   optional region scope). Output: the ranked, labeled, region-grouped briefing with its tests-to-run and
   its truncation receipt — a conclusion, not a diff dump or a graph. Opt-in preset only.

## Decision

**Rank by an ordered tier of existing-classifier labels plus raw evidence — introduce no new weighted
significance score and no new tuning constant.** The temptation is to define `significance =
f(fan_in, fan_out, churn, recency)` and sort by it; that would be deterministic but it would bake in
arbitrary weights, the exact "hidden formula" the north star excludes. Instead the briefing reuses the
hub/chokepoint classifiers and the churn signal that already exist, composes them into a small fixed set
of labels with a defined tier order, and exposes the raw evidence so the agent ranks the rest. The
"budget" is a bounded, receipted truncation over that tier order, not a coverage threshold over a
synthetic score.

## Scope contract — do not break these things

This change must NOT:
- Introduce a composite/weighted significance score or any new tuning constant. Labels from existing
  classifiers + raw evidence + a fixed tier order only.
- Assert a change is surprising without churn history to support it — that label is withheld below its
  evidence floor.
- Silently truncate. A bounded briefing carries a receipt of what was dropped.
- Return a diff dump or a graph. The briefing is a ranked, labeled conclusion.
- Enter the minimal/first-run tool surface. The tool is opt-in. No graph-schema change; no clock (the
  base ref, not wall-clock time, is the cursor).

## Out of scope (deferred)

A persisted per-agent cursor that auto-advances across sessions (the tool takes an explicit base ref;
session-cursor bookkeeping is a later change); cross-repo/federated briefings (single-repo first);
natural-language summarization of the changes (that is the agent's job over the conclusion); and any
ranking that depends on wall-clock recency rather than a commit cursor.

## Implementation status

Tracked in `tasks.md`. Verified by a fixture where a stable hub is modified among many trivial changes
(it surfaces top as `surprising-change`), a shallow-history fixture (the surprising label is withheld,
the symbol ranks as `hub-change`), a truncation fixture (the receipt reports the dropped count and
lowest tier), and a determinism test (byte-identical briefing for a fixed ref pair).
