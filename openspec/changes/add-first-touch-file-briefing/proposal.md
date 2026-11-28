# A short briefing the first time the agent reads or edits a file

> Priority: P1 · Not built
> Reaches the agent through: a new hook moment `after-read` (Claude Code `PostToolUse`, tool `Read`; ADR-0038), and the existing `before-edit` moment
> Why it helps the agent: it learns who depends on a file, which decisions govern it, and which tests check it at the moment it opens the file, without asking.

## Problem

Today the agent gets file-level evidence only when it asks (`orient`, `blast_radius`) or after it
edits (`after-tools`). The prompt briefing fires only when the prompt names code exactly (#758), and
most prompts do not. So in a normal session the agent reads `foo.ts`, sees its text, and does not
see that 14 functions in 6 other files call it, that decision `ab12cd34` governs it, or that a
memory on it went stale. It finds out after the edit, or never.

`before-edit` (`src/cli/commands/hook.ts`) already runs before each edit, but it only reports a
generated target and pending phantom references.

## What changes

- **A first-touch briefing.** The first time in a session that the agent reads a file (new moment
  `after-read`) or edits a file it has not read (`before-edit`), the hook prints at most 6 lines
  about that file. Each line is a fact with its proof, chosen from this closed list:
  1. Callers in other files: the up-to-3 symbols in the file with the most callers outside it,
     with the caller count, file count, and up to 2 caller files.
  2. Authoritative decisions and memories anchored to the file or its symbols (id and title);
     drifted or orphaned ones are counted in one line, never served as fact.
  3. Contracts served from the file: a route handler's `METHOD /path` and its in-repo consumer
     count; a public export's consumer count outside the package.
  4. At `before-edit` only: up to 3 test files with an `asserts-on` link to a symbol in the file
     (#799), else one line that no recognized test asserts on it.
  5. When `add-session-catch-up-briefing` has a previous-session head: the commits that changed
     the file since then (count and newest short SHA).
- **Silent unless there is something.** A line is left out when its fact is empty. A file with no
  line prints nothing. A file not in the index prints nothing.
- **Once per file per session.** Keyed in the per-session record (`hook-session.ts`). A fact that
  `orient` or `blast_radius` already served this session (the ledger's served set) is left out.
- **Fast on repeat.** A repeat touch reads only the session record and exits before it loads the
  graph. Budgets: repeat touch p95 ≤ 150 ms, first touch p95 ≤ 1.2 s, runtime limit 3 s.
- **Wired per repository** for Claude Code, like the other per-tool hooks. `hooks.after-read:
  false` turns it off.

## What does not change

- No new MCP tool, command, preset, or finding code. The facts come from the graph, the decision
  and memory stores, the contract projection, and test evidence that already exist.
- Advisory: the briefing never blocks a read or an edit.
- Local only, no LLM, no network. Works with no spec framework.

## Limits we disclose

- Claude Code only in this change. Pi and Codex get it when their hook shape allows a per-read event.
- A read through `Bash` (`cat`, `sed`) or `Grep` is not a first touch; only the `Read` tool is.
- The briefing shows what the index knew at its last build. When the file changed since then, the
  briefing says so in its first line and shows only the decision, memory, and contract lines,
  which do not depend on the file's current text.

## Depends on

Shipped: `openlore hook`, the per-session record, the session ledger's served set, test evidence
(#799), anchored decisions and memories. Optional: `add-session-catch-up-briefing` for line 5.
