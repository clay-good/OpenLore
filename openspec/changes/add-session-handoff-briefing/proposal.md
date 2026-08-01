# Session handoff briefing: succession as a computed receipt, not a lossy summary

> Status: PROPOSED (2026-07-27, field research sweep — `FIELD-RESEARCH-2026-07.md`). When an
> agent session ends mid-change — context exhausted, cleared, or moved to another machine — the
> successor session today inherits an LLM-written summary. Compute the succession artifact from
> the substrate instead: one deterministic, replayable briefing of the in-flight work. Prior
> art: the context-engineering literature measured iterative LLM rewriting eroding detail
> ("context collapse", ACE — https://arxiv.org/abs/2510.04618), and the field is converging on
> goal-scoped succession artifacts over whole-conversation compaction; the borrow is the
> succession *shape* — the content here is computed, which no surveyed system does.

## The gap

- OpenLore briefs three change-shaped situations already: `blast_radius` (my pending diff, for
  review), `briefing_since` (others' landed changes, for catch-up), and `working_set_context`
  (a spec-store change's target repos, for federation). **Nothing briefs "resume MY in-flight,
  uncommitted work in a fresh context"** — the situation every long-running agent session hits,
  on the product's own primary user.
- Continuity today rides the host's compaction summary: unanchored prose that cannot be
  verified, decays with each rewrite, and omits exactly the structural facts (which symbols are
  mid-edit, which anchored decisions govern them, which specs drifted, which tests must run)
  the substrate holds fresh.
- Every ingredient exists as a shipped lookup: working-tree diff → touched symbols (the
  footprint machinery), anchored memories/decisions in scope with freshness verdicts (recall
  discipline), drifted specs (`check_spec_drift`), reaching tests (`select_tests`), open change
  directories whose tasks reference touched files. The missing piece is one composition with a
  succession-shaped contract.

## What changes

- **One new conclusion tool, `get_handoff_briefing`** (`full` preset, family `change`; CLI
  `openlore handoff [--json]`). One token-budgeted briefing of the in-flight state:
  1. the working-tree diff's touched symbols, each with callers and its region;
  2. fresh anchored memories and decisions in scope (orphaned withheld, drifted flagged —
     exactly the recall/`working_set_context` discipline);
  3. drifted specs and the open `openspec/changes/*` directories whose proposal/tasks reference
     touched files, with unchecked task lines quoted;
  4. the reaching tests for the whole touched set;
  5. unfinished-signal receipts: uncommitted file list, staged-vs-unstaged split, and any
     failing/stale certificate lease.
- **Deterministic and replayable:** the same repository state produces a byte-identical
  briefing — it can be regenerated, diffed, and trusted in a way no conversation summary can.
  The briefing is pull-shaped: the successor (or a Stop-hook, or a human) requests it; nothing
  is auto-injected.
- **Just-in-time re-fetch identifiers:** every truncated or summarized element names the exact
  tool call that expands it (`get_function_body`, `recall`, `get_spec`, …), so the successor
  pays tokens only for what it actually needs — the briefing is an index into the substrate,
  not a dump of it.
- **Honesty contract:** a clean working tree returns an explicit "nothing in flight" with the
  repo's current lease state, never an empty object; staleness of the index relative to the
  working tree carries the standard disclosure; token-budget truncation follows the
  peripheral-first + omission-receipt discipline (composing with, not duplicating,
  `refine-orient-context-budgeting`'s machinery when that lands — a plain cap with receipts
  until then).
- **Deliberately NOT borrowed / NOT built:** conversation-transcript parsing or summarization
  (the briefing reads the repository, never the chat); host-specific plan-file formats;
  auto-injection at session start (`orient` owns session-start context; this tool owns
  succession and cross-references it); any persistence of briefings (recompute on demand — the
  repo state IS the storage).

## Why this is in scope

Session succession is the highest-frequency context-loss event in agent work, and it is the one
moment the substrate's whole value proposition — durable structural memory that outlives a
context window — pays off in a single call. The composition is entirely existing lookups under
the shipped honesty contracts; determinism makes it strictly more trustworthy than the LLM
summaries it displaces.

## Impact

- Files: one composer handler (footprint × recall × drift × select_tests × change-dir scan),
  CLI command, tool-contract classification (`conclusion`, family `change`), presets/docs.
- Specs: `cli` — 1 ADDED requirement; `mcp-handlers` — 1 ADDED requirement.
- Tool surface: +1 tool in `full` preset only; adjacent cross-references name `blast_radius`
  (diff-for-review), `briefing_since` (catch-up), and `orient` (session start) per
  NoRedundantConclusions.
- Risk: overlap confusion with `blast_radius` (mitigated: the cross-reference and the
  succession-only fields — task quotes, unfinished receipts, re-fetch identifiers — keep the
  conclusions distinct); large in-flight diffs blowing the budget (mitigated: budget +
  omission receipts); change-dir scan cost (bounded: proposals/tasks are small text files,
  scanned for touched-path mentions only).
