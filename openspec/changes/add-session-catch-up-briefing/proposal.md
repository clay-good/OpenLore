# What changed since the last session, on the first prompt

> Priority: P1 · Not built
> Reaches the agent through: the prompt-submitted moment (`orient --inject`), in the same once-per-session block as the slim digest
> Why it helps the agent: a new session starts from what is true now, not from what the agent or the last session's notes assume.

## Problem

Each session starts cold. Between two sessions in one repository, teammates and other agents merge
commits, decisions are recorded or superseded, and remembered facts go stale. The agent learns this
only if it asks (`briefing_since` is opt-in, `--preset full`) or when an old assumption breaks.
OpenLore already has every input: each session's record keeps the head it started at
(`startHead`, `src/core/services/hook-session.ts`), `handleBriefingSince` ranks changed symbols,
the decision store has dates and supersessions, and `recall` knows which memories drifted.

## What changes

- **Remember where the last session ended.** Each write of a session record also writes
  `last-session.json` beside the records: the session id and the head at that write. Session
  records are pruned after 7 days; this one file is not, so a session after a long gap still has a
  base. The catch-up base is the head in that file when its session id is not the current one.
- **At most 6 lines on the first prompt of a session**, after the slim digest:
  1. The base commit and the number of commits since it.
  2. Up to 3 changed symbols in the tiers `surprising-change`, `hub-change`, or
     `chokepoint-change` from `handleBriefingSince` (tier, name, file). Ordinary changes are only
     counted.
  3. Decisions recorded, superseded, or rejected since the base (id and title).
  4. Memories whose anchor drifted or was orphaned since the base (count, up to 2 names).
  5. Live peers on the board (count and branch).
- **Silent unless something is notable.** When none of lines 2-5 has a fact, nothing is printed,
  not even line 1. The first session in a repository prints nothing (there is no base).
- **Not assessed is said, once.** When the base is not an ancestor of HEAD (rebase, shallow clone,
  another branch), one line says so with the reason. It never guesses a base.

## What does not change

- No new tool, command, preset, or config key. `briefing_since` keeps its name and opt-in preset;
  this change calls its handler in-process.
- `contextInjection.mode: "off"` turns it off. Without a `session_id`, nothing is printed.
- The cursor is a commit, never wall-clock time. Local git only, no LLM, no spec framework needed.

## Limits we disclose

- "Last session" means the newest session record on this machine for this repository. Work done
  on another machine shows only as commits.
- Uncommitted changes from a previous session are not in the commit range. The session ledger
  already reports background changes to files the agent was served.
- The block counts against the injection token budget. When the task block and the catch-up do
  not both fit, the task block is kept and the catch-up says how many lines were cut.

## Depends on

- `adopt-agent-context-interop` group 2 (the once-per-session delivery in `buildInjection`).
- Shipped: the per-session record, `handleBriefingSince`, the decision store, memory anchor
  verdicts, the peer board.
