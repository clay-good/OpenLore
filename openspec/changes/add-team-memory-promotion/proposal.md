# Add team memory promotion: git-native, PR-reviewed shared memory

> Status: PROPOSED (2026-07-27, ecosystem research sweep). A `promote` path moves a memory from
> the agent-local store into a repo-tracked team store, one file per memory. The human gate is
> code review itself — a promotion is a commit, a rejection is a PR comment, the audit trail is
> `git log`. Prior art: human-gated shared-memory writes as the emerging governance pattern
> (https://www.augmentcode.com/guides/cross-agent-organizational-memory; scoped policy-based
> retrieval in https://arxiv.org/abs/2606.24535).

## The gap

OpenLore's memory is single-machine. The local store (`.openlore/memory/notes.json`,
`src/types/index.ts:851`) is per-checkout; the federation shipped an index-of-indexes but
explicitly deferred fleet memory (group 4). So the highest-value durable facts an agent earns —
"this cap silently drops work", "this module's locking order is X-then-Y" — die on the machine
that learned them. Every teammate's agent, and every CI agent, re-learns them from scratch or
never does. The 2026 pattern for sharing agent knowledge safely is convergent: writes to shared
memory go through a human gate. OpenLore already has the perfect gate — the pull request — and
already versions everything else it governs through git.

## What changes

- **A tracked team store**: `.openlore/memory/team/<id>.json` — one canonical-JSON file per
  memory (stable id, anchors, content hash, provenance), committed to the repo. One file per
  memory keeps merges append-only and conflict-free in the common case; `gitignore-manager.ts`
  learns to keep this path un-ignored.
- **`openlore memory promote <id>`** copies a local memory into the team store verbatim (same id,
  same anchors — no rewriting). The user commits and opens a PR like any other change; review IS
  the approval. Nothing in OpenLore auto-commits.
- **`recall` merges both stores** and labels each result's tier (`local` | `team`). Anchor
  freshness, orphan handling, claim verdicts, and rename carry-forward apply identically to team
  memories — the continuity pass already re-points anchors at analyze time, so a team memory
  survives refactors on every clone the same way.
- **Collisions use the existing arbitration**: a local memory contradicting a team memory on the
  same anchor surfaces through the existing `unreconciled` machinery with tiers disclosed — team
  is the default-preferred tier, never a silent winner. Supersede chains work unchanged (ids are
  stable); superseding a team memory is itself a promotable act.

Deliberately NOT borrowed: any hosted/shared memory service, write-time policy engines, and
cross-repo fleet distribution — the transport here is the repo itself; the federation fleet-memory
group stays deferred and untouched.

## Why this is in scope

It converts OpenLore's single most differentiated asset — anchored, self-invalidating memory —
from a personal cache into institutional memory, using zero new infrastructure: git is transport,
review is governance, `git log` is audit. Fully deterministic end to end; the only "policy engine"
is the team's existing branch protection.

## Impact

- Touches: memory read path (`mcp-handlers/memory.ts` — merge + tier labels), a small
  `memory promote` CLI (house pattern: conclusion tools get CLI twins), `gitignore-manager.ts`,
  continuity carry-forward (already anchor-driven; team files just add a second store to walk).
- No new MCP tool (promote is CLI-only — a write to the working tree belongs with the user's
  commit flow, not an agent tool); `recall` output gains a `tier` field (additive).
- Specs: `mcp-handlers` — 1 ADDED requirement.
- Risk: id collisions across branches (mitigated: ids are content+anchor hashes — same fact, same
  id, merge is idempotent); secret leakage via promoted content (mitigated: promote runs the
  existing `secret-redaction.ts` scan and refuses on findings, disclosed).
