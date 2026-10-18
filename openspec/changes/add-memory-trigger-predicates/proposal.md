# Memory trigger predicates: the right memory pushes itself into the briefing, deterministically

> Status: IMPLEMENTED (2026-10-17; see tasks.md for what was built, which differs from this
> proposal in places: a dedicated linear glob matcher, one shared forward hop walk rather than
> select_tests' reachability, and no Pi injection rendering). Proposed 2026-07-03, e2e audit pass 3. Recall is pull-only: a memory helps only if
> the agent thinks to ask. Let `remember` attach an optional deterministic trigger predicate
> (file glob, symbol pattern, spec domain, call-hop proximity) and a `pinned` flag; orient /
> blast_radius / working_set_context evaluate predicates against the task's touched set and PUSH
> matching memories into the briefing, with a receipt naming which memory fired on which
> predicate. Prior art: Devin Knowledge trigger descriptions
> (https://docs.devin.ai/onboard-devin/knowledge-onboarding) WITHOUT the LLM cue — OpenHands repo
> microagents prove the deterministic form ships
> (https://docs.all-hands.dev/modules/usage/prompting/microagents-repo).

## The gap

- **Pull-only recall.** `recall` (`memory.ts:218`) returns memories only when called with a
  task. `orient` loads the memory store (`orient.ts:502`) but folds notes ONLY into
  contradiction detection — anchor-file overlap gating (`orient.ts:496-511`) feeding
  `unreconciledMemories` — and reversals; a note's *content* is never pushed into the briefing.
  The `ProactiveIntentBriefing` requirement (mcp-handlers spec:671) promises notes surface
  proactively, but its realization covers decisions (`pendingDecisions`/`staleDecisions`) and
  note *contradictions*, not the notes themselves.
- **Anchor overlap is the only relevance signal.** A gotcha about "any handler under
  `src/routes/`" or "anything that calls `EdgeStore.open`" cannot be expressed: an anchor pins
  one symbol/file (`memory.ts:53-56`). Devin's trigger descriptions and OpenHands' keyword
  triggers exist precisely because the fact's blast radius is often wider than its anchor.

## What changes

- **(a) An optional `trigger` predicate on `remember`** — a closed union, all deterministic:
  `fileGlob` (matched against touched files), `symbolPattern` (touched symbol names),
  `specDomain` (the task's relevant domains), or `withinHops: N` (the anchor lies within N
  call-graph hops of a touched symbol — computed with the existing backward-reachability
  machinery that powers `select_tests`, `test-impact.ts:150`; no new traversal). orient,
  `blast_radius`, and `working_set_context` evaluate predicates against their already-computed
  touched sets (orient's relevant files/symbols; blast_radius's diff symbols; working-set's
  per-target scope) and push matching memories' content into the briefing. No LLM interprets a
  trigger — the deliberate delta from Devin, the part OpenHands proved deterministic.
- **(b) `pinned: true`** — the memory is always included in orient's briefing for the repo (the
  OpenHands `repo.md` tier). Pinned items participate in orient's token budget as defined by the
  sibling change `refine-orient-context-budgeting` — this change invents NO budgeting of its own;
  until that lands, pinned items ride the existing bounded briefing with the existing
  omission-count disclosure.
- **(c) Accessed-knowledge receipts.** Any briefing that injected memories reports
  `injectedMemories: [{ id, firedPredicate, freshness }]` — which memory, which predicate, what
  verdict (Devin's "Accessed Knowledge" panel, made deterministic and auditable).
- **Freshness discipline unchanged:** a pushed memory carries its verdict; an orphaned memory is
  never pushed as authoritative (the same rule recall enforces —
  `OrphanedMemoriesAreNeverServedAsAuthoritativeContext`, mcp-handlers spec:113;
  `memory.ts:382`); drifted is pushed flagged `verify`. A trigger widens *when* a memory
  surfaces, never *whether* it is trustworthy.

## Why this is in scope

The memory face's stated purpose is facts that reach the next session unprompted; pull-only
recall undercuts it exactly where it matters (the agent that doesn't know a gotcha exists will
not ask). Every predicate evaluates against sets the briefing tools already compute, the hop
predicate reuses select_tests' reachability, and the receipts keep injection auditable — no new
analysis, no LLM, no new tuning constants (N is caller-chosen per memory, not a repo knob).

## Impact

- Files: `types/index.ts` (+`trigger`/`pinned` on `AnchoredMemory`, additive),
  `memory.ts` (remember params + validation), a small shared predicate evaluator both surfaces
  import, `orient.ts` (evaluate + inject + receipts), `blast-radius.ts`, `working-set.ts`,
  `mcp.ts:1992` (remember schema). Pi parity: the `before_agent_start` injection block renders
  the same pushed set via the shared module — stated in the PR either way.
- Specs: `mcp-handlers` — 1 MODIFIED (ProactiveIntentBriefing), 1 ADDED
  (MemoryTriggerPredicates).
- Tool surface: no new tool; memory tools stay in the opt-in `memory` preset (`mcp.ts:2167`).
  orient's *input* schema is unchanged (evaluation is server-side), so the default `substrate`
  prefix (<19,000 B) is untouched; remember's schema grows (memory preset + full only) — the
  full ceiling (88,000 B, `mcp-presets.test.ts:581`) is re-measured. Briefing responses grow
  only by matched memories + receipts, bounded and disclosed.
- Risk: medium. An over-broad trigger (glob `**`) could spam every briefing — mitigated by the
  receipts (attributable), bounded injection with omission disclosure, and pinned/triggered
  items being trivially editable via `supersedes`. Evaluation cost is set membership plus one
  bounded reverse traversal for `withinHops`.
