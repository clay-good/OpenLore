# Change evidence audit: STATUS.md's manual evidence pass, computed

> Status: PROPOSED (2026-07-27, field research sweep — `FIELD-RESEARCH-2026-07.md`). The
> built/unbuilt status of every open change is decided today by a manual "evidence pass" whose
> rules `STATUS.md` writes down and whose own maintenance section says to re-run rather than
> trust. Every rule in that pass is a deterministic check. Compute it.

## The gap

- `openspec/changes/STATUS.md` classifies 94 open changes by two evidence signals it defines
  precisely: a `change: <name>` marker in `src/`, and/or every requirement a change's delta
  adds already present in the main spec — with the caveat that a marker-less "shipped" claim
  must be verified against code. Project memory records the corollary the hard way:
  **tasks.md checkboxes are unreliable; verify against `src/` before building.**
- Running that pass by hand is hours of agent work per audit (the 2026-07-27 repair pass
  re-verified 10 "claims built" changes individually), and between passes the table drifts —
  its own maintenance rules say "re-verify this file by re-running the evidence pass, not by
  trusting it". A deterministic audit that exists only as prose is a standing invitation to
  stale governance data.
- The checks are all local and mechanical: marker grep, requirement-name presence diff between
  a change's `specs/*/spec.md` deltas and the main `openspec/specs/*/spec.md`, and validation
  via the `openspec` CLI. No judgment, no LLM.

## What changes

- **One CLI command, `openlore change-status [<name>] [--json]`** (no MCP tool — this is a
  maintainer/CI surface, not an agent hot-path conclusion). Per change, compute and report the
  evidence signals separately, then a verdict derived from them by a fixed rule table:
  - `marker`: present/absent (`change: <name>` scan over `src/`, with file:line receipts);
  - `requirementsSynced`: for each ADDED/MODIFIED requirement in the change's deltas, present
    in / absent from the target main spec (by requirement name, the same key the corpus uses),
    reported per requirement;
  - `validates`: the change passes `openspec validate` — **delegated to the `openspec` CLI,
    never reimplemented** (the settled lifecycle boundary);
  - verdict: `built` (marker + all synced), `built-unmarked` (all synced, no marker — carrying
    the STATUS.md caveat verbatim: verify against code before trusting), `partially-built`
    (some synced or marker without sync), `unbuilt` (neither), each with its receipts.
- **A table mode for the audit file:** `--table` emits the open-changes table body (name +
  verdict + one-line evidence) in STATUS.md's format, so the hand-maintained table can be
  regenerated instead of re-derived — the prose sections stay human-owned; only the evidence
  table is generated.
- **Honesty contract:** the command never claims runtime correctness — `built` means the
  documented evidence signals hold, and the output says so; a change whose delta files fail to
  parse is `not-assessed` with the parse error, never silently `unbuilt`; archive remains the
  `openspec` CLI's job (this command reports `archivable-candidate` only as "verdict built +
  validates", it never archives).
- **Deliberately NOT built:** any archive/lifecycle action (delegation boundary — the
  `openspec` CLI owns proposal→archive); tasks.md checkbox parsing as an evidence signal
  (documented unreliable — checkboxes are *reported* as a display column but never enter the
  verdict rule); LLM assessment of "does the code really do this"; MCP tool surface.

## Why this is in scope

This is the governance face auditing itself: the project's highest-leverage bookkeeping ritual,
already specified as deterministic rules in a committed document, becomes a command whose output
CI can check and whose receipts (marker file:line, per-requirement sync status) make every
verdict verifiable. It directly serves the STATUS.md maintenance rules ("archive promptly",
"re-run the evidence pass") and removes the class of drift the 2026-07-27 repair pass paid for.

## Impact

- Files: marker scanner (reusing the existing `change:` marker convention), delta-vs-spec
  requirement-name differ (reusing the spec parser), `openspec validate` invocation wrapper,
  verdict rule table, CLI command + `--table` renderer; fixtures with synthetic changes in the
  four verdict states.
- Specs: `cli` — 1 ADDED requirement; `openspec` — 1 ADDED requirement.
- Tool surface: no MCP tool; one CLI command.
- Risk: verdict over-trust (mitigated: the evidence-not-correctness sentence in every output,
  and `built-unmarked` carries the verify-against-code caveat verbatim); requirement-name
  matching pitfalls — the syncer dedups by name, and the same id can map to distinct
  requirements across domains (mitigated: match is name-within-target-domain, exactly the
  corpus's own key); table regeneration clobbering human prose (mitigated: `--table` emits the
  table body only, to stdout — the human pastes or a script splices it).
