# OpenLore as a background tool: due diligence and four changes (2026-10-31)

Goal: install OpenLore once. Every repository you open then sets itself up, stays current, and
records what was decided, without the user running a command. The user can always see what it did.

## What already ships (verified on `main`, 2026-10-31)

| Need | Shipped | Where |
|---|---|---|
| One entrypoint for all repositories | `openlore install` wires user scope; every git repository builds its index in the background on first use | PR #455, `cli` `ZeroInteractionOnboarding`, `AutoInitIsConsentGuarded` |
| Self-heal a stale or broken index | Read-path repair for absent, mismatched, degraded, schema-reset, unservable, aged and stale-region indexes, on every surface | PR #225, #616, `mcp-handlers` `StalenessTriggersBackgroundRepair` |
| Index current while editing | MCP server file watcher, incremental per-file updates | `analyzer` watcher requirements |
| Auto-accept with a trail | `governance.autopilot`: `auto-approved` status, append-only ledger, `decisions log` / `decisions review` | PR #223, `cli` `DecisionAutopilotMode`, `DecisionLedgerIsAppendOnly` |
| Status without asking | `openlore status`, Claude Code status line, Pi footer | PR #526, #622, #518 |
| Semantic search | `openlore embed --local` (on-device, no key); keyword index is the default | PR #191, `config` `LocalEmbedderIsAZeroConfigOptInUpgrade` |

## What still makes agents fall back to grep (each reproduced)

| Gap | Evidence | Change |
|---|---|---|
| Unchanged code reported stale (aged index; mtime-only per-file check) | roughlogic.com, published 3.5.0: "Served from a stale index", 5 unchanged files flagged | Fixed in PR #630 |
| A new worktree starts with no index | Fresh worktree of roughlogic: first call returns `notReady`, about 23 s until results | `seed-worktree-index-from-sibling-checkout` |
| Repositories wired before user scope never get it | This machine: no user-scope entry; roughlogic's repo-only wiring is untracked, so its 3 agent worktrees had no OpenLore at all | `upgrade-repo-only-wiring` |
| Auto-initialized repositories record no decisions and show no governance | Auto-init writes no gate and no `governance` block; `openlore status` has no governance section | `default-decision-autopilot-with-visible-trace` |
| Agents read the keyword-mode note as "lower quality" | Field report: "plain keyword matching instead of semantic search" | `enable-local-semantic-search-in-background` |

## Assumptions questioned

- **"Semantic search must be on by default."** No benchmark in this repository compares keyword
  with local semantic retrieval. The change measures first and turns semantic on only if it wins.
- **"Auto-accept governance in the background."** Extraction and consolidation of decisions call an
  LLM, which the background path must not need. So the agent that made the change records the
  decision (it is the LLM in the loop), and autopilot accepts it at once, with no git hook.
- **"Auto-setup means writing the user's global config."** It does not. Writing `~/.claude` stays an
  explicit command; OpenLore offers it in the places a human already looks.

## Build order

1. `upgrade-repo-only-wiring`: without user scope, the other three do not reach worktrees.
2. `seed-worktree-index-from-sibling-checkout`: needs the file hashes from PR #630.
3. `default-decision-autopilot-with-visible-trace`.
4. `enable-local-semantic-search-in-background`: measure first.
