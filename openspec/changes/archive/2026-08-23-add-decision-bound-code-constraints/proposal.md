# Decision-bound constraints: the rule lives in the decision that motivated it, and the coverage is published

> Status: BUILT (2026-08-23). OpenLore records architectural decisions
> and, separately, evaluates architecture rules from `.openlore/architecture.json`. The two never
> meet: a violation cites an anonymous rule with no rationale, a superseded decision's rule keeps
> binding forever, and nobody can say what fraction of the decision corpus is machine-enforced
> versus merely written down. Prior art: deterministic engines that carry the machine-checkable
> rule inside the governing decision artifact and publish the enforced boundary as an explicit
> ledger rather than an implied one.

## The gap

OpenLore has both halves of decision-to-code enforcement and no join between them.

- **Rules are orphaned from their reasons.** `src/core/architecture/rules.ts` reads rule kinds
  (`layers`, `forbidden`, `allowedOnly`) from `.openlore/architecture.json`. A violation reports
  that a rule was broken. It cannot report *which decision* the rule enforces, what that decision's
  rationale was, or what its consequences said — precisely the context that makes a violation
  actionable instead of a lint annoyance. The repo's own doctrine says a conclusion carries a
  receipt; an architecture violation is the one finding that carries none.
- **A retired decision's rule never retires.** The decision store has full status transitions
  (PR #252) and supersession. `architecture.json` has none. Supersede a decision and its rule keeps
  blocking merges, enforcing a position the team explicitly reversed. There is no mechanism by
  which reversing a decision reverses its enforcement.
- **`record_decision` is a write-only ritual with no teeth.** CLAUDE.md instructs agents to record
  a decision *before* writing code. Nothing then checks that the code obeys it. The decision
  becomes prose in a spec file that a future agent may or may not read — which is the exact failure
  the substrate exists to prevent.
- **Nothing states what is and is not machine-enforced.** Today a reader of the decision corpus has
  no way to distinguish "this decision is mechanically enforced on every commit" from "this
  decision is a paragraph nobody checks." That ambiguity is worse than no enforcement, because it
  invites the assumption of coverage that does not exist.

## What changes

1. **A decision may declare constraints, and its constraints inherit its lifecycle.** An
   authoritative decision may carry a versioned constraint block naming rules in the **existing**
   `src/core/architecture/rules.ts` vocabulary — no new rule kinds here; the sibling
   `widen-architecture-rule-vocabulary` owns widening that vocabulary and this change consumes
   whatever it defines. Each rule declares a stable id, a repository-relative path scope, and its
   kind-specific fields. The decision's status governs the rule: **only an authoritative decision's
   constraints are evaluated**; a superseded, rejected, or draft decision's constraints are
   evaluated by nobody and reported as retired. Reversing a decision reverses its enforcement, with
   no second edit anywhere.

2. **Violations cite the decision.** Every finding names the governing decision id and title, the
   rule id, the source path and line, and the decision's own recorded rationale — the receipt.
   Findings are emitted in the unified `GovernanceFinding` shape with registered codes, advisory by
   default, blocking only through the operator's `enforcement.policy`.

3. **An eligibility ledger — three separate numbers, never one flattering one.** Every
   authoritative decision is exactly one of:
   - **eligible** — its intent reduces to a concrete, checkable repository property;
   - **ineligible** — it does not, *with a stated reason*;
   - **unclassified** — nobody has judged yet.

   The report publishes **adoption** (constrained ÷ all authoritative), **coverage**
   (constrained ÷ eligible), the **unclassified count**, and the **active rule count** as four
   distinct measurements. It never merges them into a single percentage, because a single
   percentage is the one number that can be improved by lying in either direction.

4. **Eligibility is declared, never inferred.** OpenLore SHALL NOT classify a decision's
   eligibility automatically, in bulk, or by heuristic. An eligible decision with an empty rule set
   stays visible as a coverage gap rather than being quietly counted as covered. `unclassified` is
   an honest, permanent-until-reviewed state — not an error, and not silently folded into either
   side.

5. **A partially enforceable decision is honest about its remainder.** A decision whose intent is
   only partly checkable may be eligible when the report states both the enforced boundary and the
   part that still requires human judgment. This is the same disclosed-boundary discipline every
   analysis tool in the repo already follows.

6. **No LLM, ever, in this path.** The evaluation is regex-and-graph over repository bytes and the
   stored call graph. A model judging whether code obeys a decision would be non-deterministic,
   networked, and unfalsifiable — a direct contradiction of decision `c6d1ad07`. Decisions that
   need semantic judgment stay with human review, and the ledger makes that visible rather than
   pretending otherwise.

## Why this is in scope

The `architecture` domain already declares that both faces share one substrate. This is the one
place the faces are still severed: the governance face records *why*, the navigation face can prove
*what*, and no wire runs between them. Every part needed already exists — the decision store with
status transitions, the rule engine, the finding registry, the enforcement policy, `openlore
enforce`. This change is the join and the honesty ledger, not new machinery.

It also gives `record_decision` a reason to be called that is stronger than a commit-gate ritual: a
decision recorded with a constraint enforces itself from that moment on.

## Impact

- **Files:** decision-carried constraint parsing in `src/core/decisions/store.ts` /
  `src/core/decisions/syncer.ts`, an evaluator in `src/core/architecture/check.ts` that consumes
  decision-sourced rules through the same path as file-sourced ones, an eligibility ledger in
  `src/core/decisions/ledger.ts`, finding codes in `enforcement-policy.ts`, reporting in
  `src/cli/commands/enforce.ts` and `src/cli/commands/decisions.ts`.
- **Specs:** `architecture` — 1 ADDED requirement (decision-bound constraints and lifecycle
  inheritance); `mcp-handlers` — 1 ADDED requirement (the eligibility ledger's four measurements
  and the never-infer rule).
- **Tool surface:** no new MCP tool. `record_decision` gains an optional constraint field; the
  finding stream and the existing gate are the surface.
- **Risk:** medium, contained by two properties. Advisory by default means adoption cannot break a
  repo's build. Declared-only eligibility means the ledger cannot inflate itself. The real risk is
  the opposite one — rules that look precise while enforcing a superficial token — which is why
  every rule must be scoped to a narrow path and carry its own message, and why a rule is verified
  against the whole tree before it is trusted.
- **Sibling boundaries:** `widen-architecture-rule-vocabulary` owns *which rule kinds exist*; this
  owns *where a rule comes from, when it stops binding, and what coverage is claimed*. They compose:
  a decision may declare any kind that change defines. `add-attested-governance-artifacts` owns
  attestation of governance output; this owns the provenance of the rule itself.
