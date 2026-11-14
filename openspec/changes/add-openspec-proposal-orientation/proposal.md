# Orient any plan or spec the agent is about to write

> Priority: P2 · Not built (the OpenSpec-only version is built; see "Already built")
> Reaches the agent through: the prompt-submitted moment, then `orient`
> Why it helps the agent: a plan, spec, or proposal starts from what the user asked for and from the real code, in any spec workflow.

## Problem

The agent often writes a plan from a short prompt such as "propose it" or "write the spec." The
real request is in earlier turns. The agent can invent intent, turn an option nobody chose into a
decision, or miss the code the plan must fit.

OpenLore already corrects this, but only for OpenSpec. `isOpenSpecProposalInvocation` in
`src/cli/commands/proposal-context.ts` recognizes only `/opsx:propose`, `/openspec-propose`,
`/propose`, and prose that contains the word "openspec." A Spec Kit, Kiro, ADR, or plain-markdown
plan gets no preparation. The printed text also says "proposal files," which is OpenSpec wording.

## Already built (PR #623, not part of this change)

- The `[OpenLore proposal preparation]` block and its instruction: recover the requested outcome,
  accepted decisions, constraints, and open questions; ask one question if there is no actionable
  request; call `orient` with the brief; disclose when orientation is unavailable.
- Delivery in three harnesses: Claude Code (`orient --inject`, `buildInjection` in
  `src/cli/commands/orient-inject.ts`), Pi (`before_agent_start` in `src/pi/extension.ts`), and
  Codex (`orient --proposal-only`, wired by `src/cli/install/adapters/codex.ts`).
- Pi's on-demand default with `pi.contextMode: "full"` as the opt-in.

## What changes

- **Recognize plan authoring in any workflow.** A new `isPlanAuthoringInvocation` in
  `proposal-context.ts` accepts a closed list: the OpenSpec forms above (unchanged), the Spec Kit
  commands (`/speckit.specify`, `/speckit.plan`, `/speckit.tasks`), and a narrow phrase rule: a
  verb (create, draft, write) close to a plan noun (spec, requirements, design doc, ADR, RFC,
  proposal, implementation plan). `proposalContextForPrompt` calls it. No spec framework has to be
  installed.
- **Neutral instruction text.** The block says "plan or spec files," not "proposal files." The
  header `[OpenLore proposal preparation]` stays, so current hooks and tests keep matching.
- **Name where the plan belongs, when known.** When the detector from the change
  `spec-framework-neutrality` reports the repository's spec layout (for example `openspec/`,
  `.specify/`, `.kiro/specs/`, `docs/adr/`), the block adds one line with that path and format.
  Without that change, or when nothing is detected, the line is absent.
- The block still joins the normal task orientation that `orient --inject` prints. Pi and Codex get
  the same text from the same function.

## What does not change

- No new tool, command, flag, or config key. `isOpenSpecProposalInvocation`, `--proposal-only`, and
  the block header keep their names.
- Advisory only: the block is an instruction to the agent. It blocks nothing and writes no files.
- Local only. No LLM: detection is a fixed pattern list.
- `contextInjection.mode: "off"` still turns the block off.

## Limits we disclose

- Detection is a closed list of commands and phrases. A plan started with other wording gets normal
  task orientation and no preparation block.
- The hook sees only the submitted prompt. The agent, not OpenLore, recovers intent from the
  conversation.
- Reading Spec Kit, Kiro, ADR, or plain-markdown content is not in this change. It comes from
  `spec-framework-neutrality`.
- A harness whose prompt hook passes an expanded skill prompt can hide a slash command. Then only
  the phrase rule can match.

## Depends on

- Shipped: `proposal-context.ts`, `orient --inject`, the Pi and Codex prompt hooks.
- `spec-framework-neutrality` (separate change) for the "where the plan belongs" line only.
