# Change set: first-run e2e audit 2026-07-27 — dogfood the current main as a brand-new user

Method: built `main` from source (`node dist/cli/index.js`, never the published npx), then ran
the real first-run flow on two clean sandbox repos — a small polyglot repo (2 TS files, 1 Python
script, pre-existing `CLAUDE.md` / `.claude/settings.json` / `.gitignore`) and a non-git repo —
end to end: `install` → hook commands verbatim → `orient` (task / no task / inject) → `analyze`
(re-run / `--force`) → MCP stdio (`initialize` → `tools/list` → `tools/call`) → `doctor` →
`generate` (no key) → `prove --estimate` → `install --dry-run` / `--uninstall`. Every finding
below was reproduced with a concrete command and cross-checked against the 105 open proposals so
each new change is net-new.

## What held up

- Merge-not-clobber on pre-existing user files (CLAUDE.md block append, settings.json hook merge
  preserving permissions, .gitignore append) — verified byte-level.
- Idempotency: re-install adds no duplicate hooks; re-analyze is incremental; `--dry-run` honest.
- Uninstall restores wired files faithfully (CLAUDE.md byte-identical, user permissions kept).
- `--json` purity: `orient --json` stdout parses clean; diagnostics on stderr.
- Graceful degradation: `generate` with no key lists every provider option; `doctor` outside git
  warns instead of failing; bare `openlore` gives a good first-touch help.
- MCP handshake: real version, honest capabilities, 13-tool substrate surface advertised.

## The seven new changes

| # | Change | Finding (one line) |
|---|--------|--------------------|
| 1 | `fix-first-analysis-self-contamination` | Install writes `.mcp.json`/`AGENTS.md`/CLAUDE.md block, then analyze counts them as user code: garbage `-mcp` domain (first-file dotfile fallback, `dependency-graph.ts:630-633`), Python displaced from the top-3 Languages line, `scripts/report.py` in no domain at all |
| 2 | `fix-inject-relevance-gate-keyword-mode` | `passesRelevanceGate` (`orient-inject-render.ts:139-154`) has no satisfiable branch in keyword mode below hub/fanIn≥2 — on the zero-config default, small repos NEVER get the task-scoped injection block, even for a prompt naming `chargeCard` verbatim; suppression is unobservable |
| 3 | `enforce-preset-membership-at-dispatch` | Presets filter only `tools/list`; `tools/call` dispatches any of ~73 tools — verified `find_dead_code`, `record_decision`, `remember` executing (and persisting) under the 13-tool substrate surface. Contradicts mcp-quality "strictly by opt-in" and the PR #234 read-face repositioning |
| 4 | `disclose-stale-serving-on-cold-reads` | After an on-disk edit, hook-driven `orient --json` and a cold-started MCP `orient` serve the pre-edit graph with zero staleness disclosure — the README's "told when a fact has gone stale" does not hold on the paths first-run users actually use |
| 5 | `fix-empty-orient-and-corpus-honesty` | A zero-match orient explains nothing ("greeting" vs indexed "greet") and ships decision-workflow nextSteps; BM25 corpus indexes `external::id.startsWith` as a searchable "function" (6 counted vs 5 real) |
| 6 | `align-first-run-ctas-with-repo-shape` | Install's epilogue CTA `prove --estimate` errors on the very repo install just indexed ("too sparse… try a larger repo", no numbers); the spec-index warning points at the empty dir install itself created; uninstall keeps `.openlore/` silently |
| 7 | `fix-mcp-argument-contract` | Every tool call requires an absolute `directory` (the server knows its root) with a hint-free `-32602`; `remember` silently drops an unknown `anchor:` property and persists a degraded unanchored memory |

## Found but NOT re-proposed (already owned elsewhere)

| Observation | Owner |
|---|---|
| "change the greeting" finds nothing (`greet` unstemmed) | `widen-keyword-recall-with-repo-vocabulary` |
| `openlore status` referenced in past planning does not exist on main | onboarding-autopilot arc (open); KNOWN-LIMITATIONS review already flags it |
| Missing-arg error is a protocol error, not a tool error | `adopt-mcp-protocol-conformance` (envelope); change #7 owns the default/strictness |
| Watcher-hosted self-heal converges only under `mcp`/`serve` hosts | disclosed residue of `make-index-self-healing`; change #4 adds the read-time disclosure half |

Minor nits recorded here, below spec threshold: uninstall leaves the `.gitignore` openlore block
(defensible — `.openlore/` remains); `orient --inject` writes `[ok] Successfully validated
directory` to stderr (harmless for hooks, mildly noisy).
