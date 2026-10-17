## Why

An agent recorded three decisions during a session. One was dropped twice — including after being rewritten more tightly — with no reason given. The two that survived came back with `contentOrigin: llm-extracted` and `verificationEvidence: git-diff`: the consolidator had re-derived them from the diff and kept its own wording over the author's.

The grounding is by design and worth keeping: a decision anchored to the diff is exactly the guarantee that no LLM fabricates architectural history. Two things around it are not defensible.

First, `record_decision` writes a draft (`decisions.ts:180-208`) and a background consolidator decides its fate alone. A draft that is not promoted simply stops existing, with no verdict, no reason, and no way for the caller to find out. The author is left to guess whether the call failed, the wording was wrong, or the evidence was missing.

Second, the tool's name promises more than it does. It does not record a decision; it proposes one. Renaming the tool would break an installed surface, but the description and the response can stop implying finality.

## What Changes

- Give every draft a terminal disposition at consolidation: `promoted`, `merged-into <id>`, or `rejected`, each with a stable reason code (for example `no-supporting-diff`, `duplicate-of`, `not-architectural`, `insufficient-rationale`). A draft can no longer vanish silently.
- Make the verdict readable: `record_decision` returns the draft id and states how to read its outcome, `openlore decisions status <id>` reports the disposition and reason, and a repeat `record_decision` for an already-decided draft returns that verdict rather than a second silent draft.
- Preserve the author's words. When consolidation re-derives content, the agent-recorded title and rationale are retained as `authorStatement` alongside the served content, and the response discloses that the served text is `llm-extracted`. Nothing the author wrote is discarded without trace.
- Align the tool description with the behavior: `record_decision` records a *draft proposal* subject to diff-grounded consolidation. The tool name is unchanged; only the contract text and response wording change.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `mcp-handlers`: `record_decision` discloses draft status, and every draft reaches a reasoned terminal verdict retrievable by id.
- `cli`: `openlore decisions` exposes a draft's disposition and reason.

## Impact

- `src/core/decisions/consolidator.ts` (verdict emission), `store.ts` / `atomic-store.ts` (terminal disposition, append-only), `ledger.ts`.
- `src/core/services/mcp-handlers/decisions.ts` response shape and tool description in `src/cli/commands/mcp.ts`.
- `src/cli/commands/decisions.ts` status rendering.
- Decision records gain additive fields; existing records without a disposition are read as `legacy-unknown`.
