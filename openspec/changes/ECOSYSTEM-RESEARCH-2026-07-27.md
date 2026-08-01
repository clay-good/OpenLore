# Change set: ecosystem research sweep 2026-07-27 — ten net-new proposals

This directory gained 10 change proposals on 2026-07-27, produced by a second three-track web
research sweep (agent memory & shared knowledge; code intelligence & program analysis; agent
workflows, coordination, and verification) run the same day as — and deduplicated against —
`FIELD-RESEARCH-2026-07.md`. The dedup baseline was the full open backlog (94 proposals per
`STATUS.md`), the field-research set's ten proposals *and* its "considered and deliberately not
proposed" list, and the settled won't-dos. Per project policy no competing agent product is
named in any proposal; open formats, papers, and OSS tools are cited directly, and every
proposal that touches an external tool's territory carries a "Deliberately NOT borrowed" clause.

## What this sweep established (beyond the earlier one)

- **Content rot is the unclaimed memory failure.** The field verifies stored citations with an
  agent at read time; OpenLore can do it deterministically because `remember` and `verify_claim`
  already share one graph. Anchor freshness (shipped) checks *where* a memory points; nothing
  yet checks whether what it *says* is still true.
- **Human-gated shared memory is the convergent governance pattern** — and OpenLore's gate
  already exists: the pull request. Git-native team memory needs zero new infrastructure.
- **Origin laundering is the poisoning vector** (OWASP ASI06; MINJA-style attacks): imported
  facts today inherit the authority of locally-earned ones. Write-time origin classes + read
  disclosure + policy binding is the deterministic defense.
- **The fleet era's landing-time failure is semantic, not textual**: disjoint-footprint branches
  that merge cleanly and disagree structurally. OpenLore's coordination arc covers dispatch and
  in-flight; landing is the missing phase, and the breaking-change classifier it needs already
  shipped.
- **Semantic-not-textual treatment of diffs and history** is the live code-intelligence theme
  (structural no-op suppression, AST refactoring detection). Both map onto disclosed boundaries
  OpenLore already carries (the `briefing_since` rename caveat; churn counting reformats).

## The ten proposals

| # | Change | Track | One line |
|---|--------|-------|----------|
| 1 | `add-memory-claim-verdicts` | memory | Memories carry `verify_claim`-grammar claims; recall re-verifies and serves `evidence-holds/refuted/unverifiable` — content rot caught while the anchor stays fresh |
| 2 | `add-team-memory-promotion` | memory | `memory promote` writes one tracked JSON per memory; the PR is the approval gate; recall merges tiers with unreconciled arbitration |
| 3 | `add-store-origin-provenance` | governance | Immutable write-time origin class on every memory/decision; imported facts quarantined-advisory until re-earned; `untrusted-origin-influence` finding |
| 4 | `add-invalidation-receipts` | memory | Every staleness verdict pins the invalidating commit + cause; `recall --asOf` reports closed, evidenced validity intervals |
| 5 | `add-merge-semantic-certificate` | coordination | `certify_merge`: cross-branch join of one side's signature changes × the other side's added edges — "git merges cleanly but the combination breaks" |
| 6 | `add-behavior-neutral-change-verdict` | code-intel | Per changed symbol, `provably-neutral` iff normalized trees are byte-identical; blast radius/briefing/churn subtract the proven no-ops, disclosed |
| 7 | `add-refactoring-aware-churn` | code-intel | Commit-range identity chains (rename/move/extract-with-clone-evidence) from the shipped continuity matcher; churn and coupling follow the symbol |
| 8 | `add-migration-impact-certificate` | code-intel | Rule-table verdicts on schema migrations (destructive/lock-hazardous/safe-shape) joined to surviving readers + reaching tests |
| 9 | `add-call-site-usage-profile` | code-intel | `get_usage_profile`: a per-symbol call-site census (arity/options/await/try) in the style-fingerprint `{dominant, ratio, samples}` shape |
| 10 | `add-ffi-boundary-edges` | code-intel | Declared cross-language bindings become confidence-tiered `ffi::` edges — closes the "cross-language bridges stay uncovered" residue from the limitations audit |

## How they compose

1+3+4 form the memory-trust arc (is the content still true → where did it come from → what
killed it), and 1 gives 3 its cheap quarantine exit; 2 rides 1 and 3 unchanged (a team memory
carries claims and origin like any other); 5 completes plan → in-flight → landing, reusing the
`certify_public_surface` classifier and cross-referencing the open merge-tree oracle (textual)
as its sibling; 6 de-noises the consumers 7 re-keys — a reformat commit stops being churn (6)
and a rename stops resetting it (7); 8 is the fourth instantiation of the
inventory→sites→radius→tests shape (env, logs, errors, now data); 9 extends the fingerprint
contract to symbol granularity; 10 widens the graph every one of them reads.

## Considered and deliberately not proposed

- **Event/message-broker topology bridge** — event-channel synthesis is already shipped for
  JS/TS key-literal channels (`call-graph.ts:2874-2882`, fanout-capped at `:3040`); the residue
  (broker topics, more languages, cross-repo keys) is a *widening* of that shipped rule, best
  filed against `widen-overlay-language-coverage`-style scope when demand shows, not a new
  capability.
- **Derived-predicate rule engine (Datalog-lite findings)** — the general mechanism behind the
  open `widen-architecture-rule-vocabulary`; proposing the generalization while the fixed
  vocabulary is unbuilt would be scope creep. Revisit if the vocabulary ships and teams ask for
  authoring.
- **Test-quality qualifiers (assertion-free / skipped / sleep-synchronized reaching tests)** —
  belongs inside the open `add-test-selection-safeguard-tiers` qualifier lane; noted there
  rather than duplicated.
- **Mutation-run planner** — even plan-only, it walks up to the static-only doctrine boundary
  the field-research sweep said "deserves its own explicit decision before any proposal"; that
  decision still hasn't been made, so still no proposal.
- **Sandbox/permission profile projection** — remains deferred per the field-research rejection
  (host-specific security config); the salvageable diff-side idea (a `capability-expansion`
  finding when a diff adds net-new egress/fs/spawn classes) is recorded here as design input
  for the change-certificate family.
- **Write-time near-duplicate consolidation gate** — would MODIFY the shipped
  `ContentAnchorDedup` requirement's "exact hash equality, never merge" contract; the
  unreconciled read-path machinery plus claim verdicts (#1) cover the harm with no contract
  change. Revisit only with store-bloat evidence.
- **Repo-motion confidence decay, sleep-time verification sweeps, parallel-agent memory-merge
  hazards** — real but conditional: decay is mostly subsumed by #1+#4's evidence trail;
  idle-time precomputation is a latency optimization that earns its place only if claim-bearing
  stores make recall measurably slow; memory-merge hazards should trail coordination-preset
  adoption. All three recorded as design input.
- **Unawaited-async lower bound, doc-signature drift** — linter-adjacent; the graph-join
  variants (cross-file async resolution; documented-throws vs computed escapes) are noted as
  possible future widenings of `analyze_error_propagation`'s family rather than standalone
  tools.
- **Dependency blast radius, AGENTS.md managed block, line-level AI provenance, OTel span
  emission** — already owned by `add-dependency-impact-analysis`,
  `adopt-agent-context-interop`, `add-line-provenance-evidence`, and the settled
  runtime-observability won't-do respectively.

Baseline: main @ cca1894, 94 pre-existing open changes (STATUS.md 2026-07-27) plus the 10
field-research proposals of the same date. Method: three research agents (memory/shared
knowledge; code intelligence; workflows/coordination/verification), findings diffed against the
backlog and verified against the code (every cited `file:line` was checked on this checkout)
before anything was written.
