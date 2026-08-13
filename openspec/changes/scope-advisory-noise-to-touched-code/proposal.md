## Why

A real session on an external repository (pi-outpost) ended with the agent stating that it had begun to ignore OpenLore's advisory output *in bulk*: seventeen `memory-drifted` findings, almost all anchored to files the session never touched, plus one anchor pointing at a file deleted long ago and re-reported on every run. Over the same session the pre-turn injection produced a structural briefing on a turn that said "push and open the PR", and another on "the PR was merged".

Both are the same failure: advisory output that arrives when nothing about the turn asks for it. The cost is not the tokens — it is habituation. An agent that learns to skip the block skips it on the turn where it would have mattered, and the epistemic lease loses its force. The relevance gate today (`orient-inject-render.ts`) measures whether the *repository* has something matching the prompt's keywords; it never asks whether the *turn* is doing code work. Memory staleness (`drift-detector.ts:645-720`) ranges over every anchored record regardless of what the current change touches, and an orphaned anchor has no terminal state, so it is reported forever.

## What Changes

- Add a deterministic turn-intent gate in front of the pre-turn injection: a turn whose intent is repository management (push, open/merge a PR, release, changelog, rebase, status) yields the pointer line, never a structural briefing. No LLM, no new score; the existing relevance gate still applies on top for code-work turns.
- Disclose why the injection was withheld (`gateReason`) so a withheld block is a decision with a receipt, not silence.
- Bound the gate's own failure mode: while injection is enabled the hook always emits, and the pointer line states in agent-visible text which cause withheld the briefing — "not classified as code work" reads differently from "nothing matched strongly" — and names the manual orientation call. A misclassified turn then costs a pre-computed briefing, never the knowledge that one was skipped. Silence stays reserved for an operator who turned injection off.
- Scope memory drift findings to the change under review when the caller supplies a scope (diff, changed files, or region): anchors that do not intersect the scope are counted, not enumerated. An unscoped run keeps repo-wide reporting.
- Give an orphaned anchor a terminal state. When the anchored file is absent from both the working tree and `HEAD`, the record is retired once with a stable reason and stops being re-reported; it stays queryable via `asOf`. Retirement never deletes recorded text.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `cli`: The pre-turn context injection gains an intent gate and a disclosed withhold reason.
- `drift`: Memory staleness findings become scope-aware, and an anchor to a deleted file reaches a terminal retired state instead of being re-reported indefinitely.

## Impact

- `src/cli/commands/orient-inject-render.ts` (gate), `orient-inject.ts` (wiring), and their tests.
- `src/core/drift/drift-detector.ts` memory-staleness section and `memory-staleness.test.ts`.
- The anchored-fact store gains a retired disposition; `recall` must keep serving retired records under `asOf`.
- Config: an operator can disable the intent gate under `contextInjection` (default on).
