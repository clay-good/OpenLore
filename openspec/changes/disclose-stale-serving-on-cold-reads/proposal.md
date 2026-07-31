# Disclose stale serving on cold reads: never a confident answer from an index the working tree has outrun

> Status: PROPOSED (2026-07-27, first-run e2e). The README promises an agent is "*told when a
> fact has gone stale* instead of served a confident guess." On the two read paths a first-time
> user actually exercises — the hook-driven one-shot `orient --json`/`--inject`, and the first
> calls of a freshly-started MCP session — the promise does not hold: an index that is behind the
> working tree is served **with no staleness signal anywhere in the payload**. Verified live:
> after appending `refundCard` to `src/payments.ts`, both `openlore orient --json --task
> "refundCard behavior"` and a cold-started MCP `orient` returned the pre-edit graph (no
> `refundCard`, `chargeCard` ranked instead) with zero disclosure fields.

## The gap

- **The freshness machinery that exists doesn't cover these paths.** The watcher self-heal
  (`make-index-self-healing`; `mcp-watcher.ts` stale-region scheduling) requires a hosted watcher
  — it converges *forward* from fs events observed while running. An edit made before the server
  started, and every one-shot CLI invocation (no watcher at all), fall outside it. The epistemic
  lease weighs *tool-call history within a session*, not artifact-vs-working-tree drift. The
  dual-baseline freshness check (content-hash else mtime) exists — but only inside
  `locate_symbol_span` (`add-symbol-span-locator`), which made exactly this comparison its core
  contract. `orient`, `search_code`, `get_subgraph`, `blast_radius` do not perform it.
- **The primary first-run path is the uncovered path.** Install wires `npx --yes openlore orient
  --json` (SessionStart) and `orient --inject` (UserPromptSubmit) — one-shot processes, one per
  prompt, in a session where the user is editing continuously. Every hook-driven orientation in
  an active editing session is potentially stale-served, silently, until something re-analyzes.
- **Honesty doctrine already names this failure mode.** Every conclusion tool's contract
  ("SOUND LOWER BOUND", "disclosed boundary") assumes the graph corresponds to the source being
  reasoned about. A stale cold read violates the assumption invisibly — the exact
  "confident-looking silence" the product exists to prevent, in the product's own output.

Adjacent work does not cover it: `make-index-self-healing` (shipped) is watcher-hosted repair;
`prioritize-incremental-closure-budget` orders the budget; `refine-first-run-partial-serving` is
about serving before the *first* index exists. None adds a read-time freshness check.

## What changes

- **Read-time freshness check, bounded to what the answer cites.** Before a conclusion payload is
  served, the handler compares the files it is about to cite (relevant files/functions' source
  files — typically < 10) against the artifact's recorded baseline, mtime-first with content-hash
  confirmation — the `locate_symbol_span` dual-baseline mechanic, extracted into a shared helper.
  Cost is a handful of stats on already-known paths, not a repo scan.
- **Mismatch → disclosure, never blocking.** The payload gains a staleness note naming the files
  that have moved since the index was built ("index is behind the working tree for:
  src/payments.ts — results may omit recent edits; re-run analyze or let the watcher converge").
  The result is still served (fail-open, hook discipline).
- **Where a repair path is wired, detected staleness feeds it.** Under `--watch-auto` or a serve
  daemon, a cold-read detection hands the stale files to the existing stale-region/self-rebuild
  machinery and says so ("repair scheduled"). One-shot CLI reads disclose only.
- **The lease learns the distinction.** The freshness note is factual and per-conclusion —
  distinct from the session-age lease preamble, which stays as is.

## Impact

- Affected specs: `mcp-handlers`, `cli`
- Affected code: shared freshness helper (extracted from the span-locator's dual-baseline
  check), `orient` handler + the conclusion handlers that cite files, `orient --json/--inject`
  CLI path, watcher/serve handoff. README claim becomes true as written.
