# Corpus intent review: catch the requirement that got quietly weakened

> Status: PROPOSED (2026-07-31, external-pattern study). OpenLore reviews changes to *code*
> (`structural_diff`, `blast_radius`, `briefing_since`) and checks code against *specs*
> (`check_spec_drift`). Nothing reviews changes to the **specs themselves**. A pull request that
> turns `SHALL` into `should`, deletes a scenario, or replaces "within 200 ms" with "quickly"
> passes every gate OpenLore has — and it has just rewritten the standard every future agent
> session will be grounded on. Prior art: deterministic pull-request review of a knowledge corpus,
> answering "what changed between these two states, and does a human need to look?"

## The gap

The governance corpus is the substrate's trust anchor. Every downstream conclusion — `get_spec`,
`search_specs`, `check_spec_drift`, `audit_spec_coverage`, the decisions gate, `orient`'s spec
section — reads it and presents it as settled. Weakening it is therefore the highest-leverage way
to make the whole substrate confidently wrong, and it is the one change class with no review at all:

- **`check_spec_drift` compares spec to code, not spec to spec.** It fires when code moves away
  from a requirement. When the *requirement* moves toward the code, drift silently resolves — the
  gate goes green because the standard was lowered. That is the failure mode inverted: the tool
  reports success at the exact moment it should report alarm.
- **`briefing_since` ranks changed *production symbols*** (its candidate set is hand-authored source
  code, `src/core/analyzer/change-significance.ts`). A spec-only commit is invisible to it.
- **`structural_diff`'s footprint-escape machinery reasons about symbols**, not requirements.
- **The decisions gate governs whether a decision was *recorded*,** not whether an existing one was
  weakened. `src/core/decisions/syncer.ts` writes requirements into the corpus; nothing reviews an
  edit to what it wrote.
- **Normative force is invisible to every current check.** OpenSpec requirements are normative by
  keyword (`SHALL`, `MUST`, `SHOULD`, `MAY`) and by scenario coverage. `openspec-compat.ts`
  validates that a requirement *has* a scenario; it cannot see that it used to have three.
- **The 2026-07-27 repair pass proves the class is real.** `STATUS.md` records 39 decision-synced
  requirements repaired, 11 cross-domain stubs rewritten, and scenario-less requirements emitted by
  the syncer's own template. Every one of those was a corpus regression found by hand, months late.

## What changes

**One deterministic reviewer of corpus deltas between two refs**, emitting registered findings and
a verdict with reasons. It never judges whether a change is *right* — it decides whether a human
should look before it lands.

1. **`openlore review-corpus [--base <ref>] [--head <ref>]`**, and the same engine wired as a
   finding source into `openlore enforce`. Both refs accept a git revision or a directory; the
   working tree is the default head.

2. **A closed intent-finding table**, source-declared beside `FINDING_CODE_REGISTRY`, over the
   requirement/scenario structure `openspec-compat.ts` already parses. Every rule is a structural
   comparison of two parsed corpora — no diff heuristics, no similarity model, no LLM:

   | Finding | Fires when |
   |---|---|
   | `corpus-normative-weakened` | a requirement's strongest normative keyword drops a rank (`SHALL`/`MUST` → `SHOULD` → `MAY` → none) |
   | `corpus-scenario-removed` | a requirement that had N scenarios now has fewer, and no renamed successor is matched |
   | `corpus-requirement-removed` | a requirement present in base is absent in head with no rename match and no archive record |
   | `corpus-specificity-lost` | a measurable clause (a number with a unit, an enumerated set, a named threshold) present in base is absent from the head text of the same requirement |
   | `corpus-boundary-clause-removed` | a disclosed-boundary or honesty clause is deleted (the corpus's own "SHALL disclose"/"SHALL NOT claim" sentences) |
   | `corpus-decision-status-regressed` | a decision moves from an authoritative status to a weaker one without a recorded superseder |
   | `corpus-delta-orphaned` | a change delta's target requirement disappeared from the corpus between the two refs |

   A rename is matched by exact requirement-name continuity first, then by an identical scenario
   set; **when neither matches, the change is reported as a removal, not guessed as a rename.**

3. **A verdict with reasons, not a score.** The output states `review-recommended` or
   `no-review-needed`, and when review is recommended it lists each reason as the finding that
   produced it. There is no number, no weighted severity, no confidence percentage — the substrate
   does not produce semantic verdicts, and a rank order of prose changes would be exactly that.

4. **Advisory before gate.** Findings are advisory by default and become blocking only through the
   operator's existing `enforcement.policy`. This is the sequencing the repo already follows for
   every enforcement capability it has shipped, stated here explicitly so it is not re-litigated.

5. **Read-only revision materialization.** Base and head are materialized read-only — no `git
   worktree`, no checkout, no index or `HEAD` mutation — so the review is safe to run concurrently
   in CI and alongside a developer's working tree. Path arguments go through the existing
   `gitPathArgs()` quoting discipline (PR #249).

## Why this is in scope

`drift`'s purpose is detecting divergence between the corpus and reality and computing staleness
against git history. Today it looks in exactly one direction. This change adds the other direction
using the parser (`openspec-compat.ts`), the finding registry (`enforcement-policy.ts`), the git
layer (`src/core/drift/git-diff.ts`), and the enforcement gate (`src/cli/commands/enforce.ts`) that
all already exist. No new store, no new artifact, no LLM.

It is also the reviewer OpenLore's own process needs: the repo has 120 open changes whose deltas
mutate a 15-domain spec corpus, and its own status document records that the last corpus regression
was found by a manual repair pass.

## Impact

- **Files:** new `src/core/drift/corpus-intent-review.ts` (rule table + comparer + verdict), new
  `src/cli/commands/review-corpus.ts`, read-only revision materialization in
  `src/core/drift/git-diff.ts`, finding codes registered in `enforcement-policy.ts`, a
  rule-table-closure guard test.
- **Specs:** `drift` — 1 ADDED requirement (corpus intent review + verdict); `cli` — 1 ADDED
  requirement (the command's contract, output modes, and exit codes).
- **Tool surface:** no new MCP tool. The finding stream and the CLI are the product.
- **Risk:** low. Advisory by default; a false positive costs a reviewer one glance. The one real
  risk is rename churn producing removal findings, which is why rename matching is explicit and its
  failure is reported honestly rather than guessed.
- **Sibling boundaries:** `add-knowledge-corpus-integrity` checks the corpus *as it stands*; this
  reviews what *changed*. `briefing_since` ranks changed production symbols; this ranks nothing and
  covers spec artifacts it cannot see. `check_spec_drift` is spec→code; this is spec→spec.
  `add-scenario-checkability-binding` owns whether a scenario is checkable; this owns whether one
  disappeared.
