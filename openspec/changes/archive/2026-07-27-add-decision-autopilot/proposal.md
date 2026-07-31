# Decision autopilot: auto-accept governance with a first-class audit trail

> Status: IMPLEMENTED (2026-07-18, PR #223). The decisions gate is the substrate's governance heartbeat,
> but its only mode is *blocking human review*: every commit with staged source either stops
> for interactive approval or is bypassed with `--no-verify`. That friction is exactly why
> the gate ships behind a separate opt-in command and why real users end up rubber-stamping.
> This change adds an **autopilot** mode: decisions are recorded, consolidated, auto-accepted,
> and synced entirely in the background — commits never block — while every acceptance lands
> on an append-only, human-readable trail that can be reviewed, promoted, or reverted at any
> time. Governance gets out of the way without disappearing.

## The gap

- **No auto-accept exists.** Approval is human-only (`--approve <id>`,
  `src/cli/commands/decisions.ts:418-429`); the gate state machine
  (`classifyGateState`, `src/core/decisions/gate-state.ts:55-70`) has no non-blocking
  resolution for `verified` decisions — they wait for a human or a `--no-verify` bypass.
- **The bypass is the de-facto autopilot, minus the trail.** The post-commit detector
  (`decisions.ts:164-179`) already shows users route around the gate; when they do, nothing
  is approved, nothing syncs to specs, and the decision record silently rots. The observed
  field behavior (standing "approve without prompting" authorizations) is autopilot demand
  being served manually.
- **Provenance would be lost if we faked it.** Auto-accepting by writing status `approved`
  would be indistinguishable from human review — the exact conflation
  `fix-decision-status-transitions` exists to prevent. Autopilot needs its own status and
  its own legal transitions in that state machine, not a side door.
- **There is no trail to inspect.** `pending.json` (`src/core/decisions/store.ts:18-22`)
  holds current status only; transitions overwrite. Nobody can answer "what did OpenLore
  accept on my behalf last week, and who said so?"

## What changes

1. **A `governance.autopilot` mode** (config: `governance: { autopilot: true }`). When on:
   - decisions reaching `verified` are transitioned to a NEW status **`auto-approved`**
     (actor `autopilot`, timestamp, triggering commit) and synced to specs in the background;
   - the pre-commit gate never blocks — it emits one advisory line
     ("2 decisions auto-accepted · `openlore decisions log`") and exits 0;
   - infrastructure failure (consolidation/sync error) degrades to a caveat and exits 0,
     reusing the impact-certificate advisory-safety discipline.
   When off, behavior is exactly today's blocking review flow.
2. **An append-only ledger.** Every status transition (record, consolidate, verify,
   auto-approve, human approve/reject, sync, supersede) appends
   `{ id, title, from, to, actor: human|autopilot|agent|sync, at, commit }` to
   `.openlore/decisions/ledger.jsonl`. `openlore decisions log [--json] [--since <ref>]`
   renders it newest-first. The ledger is written by the same code path for every mode —
   human review gets the trail too.
3. **Review and revert, any time.** `openlore decisions review` lists auto-approved-and-
   never-human-reviewed decisions for bulk disposition: promote (→ human `approved`) or
   reject. Rejecting an auto-approved decision retires it from specs through the existing
   supersession machinery (kept queryable via `asOf`) — reversible, not destructive.
4. **Honest provenance everywhere.** Specs render auto-approved decisions with an explicit
   "auto-accepted (unreviewed)" marker; `recall` and `verify_claim`'s `decision-current`
   treat `auto-approved` as authoritative but carry the provenance so an agent citing the
   decision can say so. Status-transition legality extends `fix-decision-status-transitions`:
   `verified → auto-approved` is legal only for actor `autopilot` with the mode on;
   `rejected → *` remains human-only — autopilot can never resurrect a human rejection.

## Impact

- Specs touched: `cli` (gate + ledger + review requirements), `mcp-handlers`
  (recall/verify provenance).
- Likely code: `src/core/decisions/gate-state.ts`, `src/core/decisions/store.ts` (+ ledger
  writer), `src/cli/commands/decisions.ts`, `src/core/decisions/syncer.ts`,
  `src/core/services/mcp-handlers/memory.ts` / `verify.ts` (provenance surfacing).
- Enables: `unify-onboarding-entrypoint` step 3 (install wires the hook in autopilot mode
  by default).
- Cross-references (do not duplicate): `fix-decision-status-transitions` and
  `harden-decision-consolidation` fix the *existing* transition/CAS/spawn defects — this
  change layers a new legal transition on top of their state machine, and depends on their
  CAS discipline for ledger+status writes.

## Non-goals

- No LLM in any new path (consolidation already owns that; unchanged).
- No change to `approve_decision` requiring human authorization — autopilot is a *mode the
  human turned on*, recorded as such; the MCP tool still never self-approves.
- No deletion: rejection of an auto-approved decision supersedes, never erases.
