# ADR-0038: Make OpenLore as trusted as grep: push exact evidence while the agent works, and let the agent settle governance

## Status

accepted

**Domains**: architecture, cli, mcp-handlers

## Context

Owner direction 2026-11-27, after the agent's own review of its usefulness: agents must trust
OpenLore the way they trust grep, and understand the codebase constantly as they work. Measured
that day: the agent reads about 13 KB of standing text before any work, and evidence reaches it
mostly when it asks, when a prompt names code exactly, or after an edit. Governance should reach
the agent as findings it can settle itself; a human is involved only when the evidence warrants it.

## Decision

Make OpenLore as trusted as grep: push exact evidence while the agent works, and let the agent settle governance

## Consequences

Keeps every rule of ADR-0036: no new MCP tools, integrations, services or network calls; no LLM in
the hot path; no renames or aliases; Pi and presets stay supported; enforcement stays opt-in; cut
work is deleted and listed with a restore commit in `ROADMAP.md`.

Adds:

1. **Trust bar.** Every pushed fact is exact, or says "not assessed" with the reason. A fact kind
   found wrong is fixed or removed before a new kind ships.
2. **Moments.** The first touch of a file in a session (`after-read`) joins prompt submitted,
   before an edit, after an edit, and before stop. The first prompt of a session may carry a
   catch-up of what changed since the last session.
3. **Pushed, not taught.** Standing instructions stay a few lines. Evidence arrives when it is
   relevant.
4. **Hand-back at stop.** Open findings that are new since the last stop are handed back to the
   agent once, with proof, so it fixes them or records a decision. The same set is never handed
   back twice. This is a hand-back, not enforcement.
5. **Raise to a human only when warranted:** a breaking change to a contract with consumers outside
   the repository, overriding or superseding an accepted decision, an added secret, or a finding
   the agent cannot fix or decide from the evidence.
6. **Proof from daily use.** Success is measured by evidence yield in `openlore status`; a kind the
   agent never uses is cut.

> Recorded by openlore decisions on 2026-11-27
> Decision ID: 35c3f807
> Supersedes: b30f08a9
