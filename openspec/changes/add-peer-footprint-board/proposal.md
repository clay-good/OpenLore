# Peer footprint board: the shared, computed facts parallel agents need about each other

> Status: PROPOSED (2026-10-31, `CONTRACT-GRAPH-AND-AGENT-LOOP-2026-10.md`). A local board of live
> agent footprints shared by every worktree of one clone, read by the coordination tools that already
> exist, and pushed to peers through the loop hooks. One new write tool. OpenLore computes and
> publishes coordination facts; it does not carry messages, spawn agents, or hold locks.

## The gap

Parallel agents are the 2026 default (Claude Code agent teams, Codex and Cursor parallel tasks in
worktrees, Claude Squad / Vibe Kanban / Conductor). They fail together in measurable ways:

- Two cooperating agents reach about 25% success on CooperBench, roughly 50% below one agent doing
  both features (https://arxiv.org/abs/2601.13295); MAST names inter-agent misalignment and missing
  verification as two of its three failure groups (https://arxiv.org/abs/2503.13657).
- About 42% of merge conflicts across 33,596 agent PRs are structural — modify/delete, add/add
  (https://arxiv.org/abs/2607.04697) — and duplicated work starts at claim time, before any PR
  exists (https://arxiv.org/abs/2606.19616).
- Claude Code's agent-teams docs leave conflict avoidance to the prompt: "Two teammates editing the
  same file leads to overwrites. Break the work so each teammate owns a different set of files"
  (https://code.claude.com/docs/en/agent-teams). Task claiming is locked per task, not per code.

The transports exist — A2A 1.0 (https://a2a-protocol.org/latest/specification/), team mailboxes,
`SendMessage`. What none of them has is the code graph: who is about to write which *symbols*, who has
*read* a symbol a peer just changed, and whether two tasks collide. OpenLore computes exactly that
today, but only for a caller-supplied snapshot: `plan_parallel_work` and `map_in_flight_conflicts`
take task descriptors as input and forget them, and the fleet verification store
(`.openlore/coordination/`) is per worktree, so sibling worktrees never see each other's records.

## What changes

1. **The board.** A small store in the clone's git common directory
   (`$(git rev-parse --git-common-dir)/openlore/board/`), so every worktree of the clone shares it
   with no server and no network. One entry per live agent:
   `{ actor id, worktree, branch, declared write-set and read-set (symbols, with content hash at
   declaration), task title (≤120 chars), declaredAt, lastSeenAt }`. Atomic writes, fail-open reads,
   bounded size.
2. **`declare_footprint` (new tool, `coordination` preset, family `coordinate`) + `openlore footprint
   declare|release|list`.** An agent (or the sub-agent-start / task-created hook on its behalf)
   declares its intended write-set and read-set as symbols or files; OpenLore resolves them to the
   footprint machinery `plan_parallel_work` already uses (`change-footprint.ts`) and returns the
   hazards against live peers in the same response. Releasing removes the entry.
3. **The existing coordination tools read the board.** `map_in_flight_conflicts` treats live board
   entries as its agent task descriptors (today caller-supplied only); `plan_parallel_work` can plan
   against them; `fleet_status` lists them. No logic is duplicated.
4. **Peer read-after-write notices.** Each session's ledger (`add-session-structural-ledger`)
   publishes its *edited* symbol hashes to the board. When a peer edits a symbol in this agent's
   declared read-set or served set, the next after-tools hook names it: `peer agent-2 (worktree
   ../feat-b) changed parseConfig, which you read at 14:02`. Only the graph knows who needs to hear
   it; the hook is the delivery.
5. **Claim-time duplicate check.** When a declared write-set *creates* a symbol name (or a file) that a
   live peer's write-set also creates, the hazard is reported as `duplicate-intent` alongside the
   existing WAW/RAW/WAR classes.
6. **Leases end on evidence.** An entry ends when released, when its branch is merged or deleted, or
   when `lastSeenAt` is older than the session-expiry rule the panic state already uses. A declared
   symbol whose hash changed since declaration is shown as `moved-since-declared`, not silently
   kept.
7. **Fleet records move to the shared store.** The fleet verification records move from the
   per-worktree `.openlore/coordination/` to the board directory, so a verdict one worktree proved is
   visible, with its drift check, to its siblings (addendum to `add-fleet-coordination-arc`).

## Honesty and safety

- **No free-text messages.** The board holds structured fields only. The task title is redacted with
  the existing credential patterns and withheld if instruction-shaped, the same rules the memory
  push uses; peers' entries are served as `local-unreviewed` data, never as instructions.
- **Advisory.** Hazards never block a write. A team may make `parallel-work-conflict` or
  `duplicate-intent` blocking at the task-created hook through `enforcement.policy`.
- **Local scope.** One clone. Peers in other clones or on other machines are a disclosed boundary;
  federation of boards is out of scope for v1.

## Not built

Message transport or mailboxes (A2A, team mailboxes, `SendMessage` already do this); spawning,
scheduling, or assigning work; locks that prevent writes; a network service; any LLM.

## Impact

- Files: board store (git common dir), `declare_footprint` handler + CLI, board reader in
  `map_in_flight_conflicts` / `plan_parallel_work` / `fleet_status`, ledger publish of edited
  hashes, peer notice in the after-tools hook, `duplicate-intent` hazard class, fleet store move.
- Specs: `mcp-handlers` — 2 ADDED.
- Tool surface: +1 tool (`declare_footprint`, `coordination` preset only); siblings
  `plan_parallel_work`, `map_in_flight_conflicts`, `fleet_status`.
- Findings: `duplicate-intent` registered (advisory).
