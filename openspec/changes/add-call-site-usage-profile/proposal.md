# Show how the codebase calls a function before the agent writes a new call

> Priority: P3 · Not built
> Reaches the agent through: `orient` (and so the prompt-submitted hook), and `blast_radius` when a signature changes
> Why it helps the agent: it copies the call shape the repository already uses, and sees which callers a signature change breaks.

## Problem

Agents write calls that look right but do not match the codebase: they skip the `timeout` option
every caller passes, drop a result every caller awaits, or call bare what is always inside a `try`.
`orient` tells the agent who calls a function, not how. Every call site is already stored with its
line (`CallEdge.line`, `src/core/analyzer/call-graph-types.ts`), so the answer is a count away.

## What changes

- A count over a symbol's resolved call sites: re-read each site and parse the call expression.
  Four facets: argument count, named options passed (TS object keys, Python keywords), result use
  (`awaited | returned | assigned | discarded`), and inside a `try` or not.
- `orient` gains `callProfile` on each target function that has enough call sites: one line (for
  example "`fetchUser`: awaited in 14/14 calls; `timeout` passed in 12/14") and up to 3 example
  call sites with `file:line`. Examples are picked in a fixed order: production before test,
  different regions first, then path order.
- `blast_radius` gains the same `callProfile` on a changed function whose parameter list differs
  from the merge-base, so the agent sees how existing callers pass arguments before it stops.
- The evidence floor is the existing `STYLE_EVIDENCE_FLOOR` (`src/core/analyzer/style-fingerprint.ts`).
  Below it, the field is absent.

## What does not change

- No new tool and no new command. `orient` and `blast_radius` keep their names and current fields.
- Descriptive only: it reports observed counts, never "correct usage". No finding, nothing blocks.
- Computed live from the cached graph and a re-read of source. No new stored file.
- Local only. Works without OpenSpec.

## Limits we disclose

- TypeScript, JavaScript and Python only. Other languages get no `callProfile`.
- A site with spread or dynamic arguments is not counted for argument count; the number of such
  sites is stated.
- Sites reached only through synthesized or name-only edges are left out, with the count stated.
- Callers outside the repository are not seen. The profile is what this repository does.

## Depends on

Shipped: call edges with lines, the style fingerprint's floor, merge-base blob reads used by
`structural_diff`.
