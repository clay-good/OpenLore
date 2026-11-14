# Finish the verify_change receipt: every diff check in one place, before and after the edit

> Priority: P2 · Partly built (the `verify_change` tool and its before-stop hook shipped)
> Reaches the agent through: `verify_change`; the before-stop hook moment
> Why it helps the agent: one receipt names every break the diff causes, with proof, at the moment the agent can still fix it.

## Problem

`verify_change` shipped in #605 and the before-stop hook calls it (#637). It folds in `blast_radius`
(which carries `select_tests` and spec drift), `structural_diff` (removed and re-signed functions,
deprecated calls, check weakening #634), the generated-file guard (#629), phantom references (#632),
and request-body checks (#658). Some diff facts OpenLore already computes still do not reach the
receipt: breaking exports, contract breaks, IaC sites that still set a renamed env key. Some diff
facts are not computed at all: new architecture violations, pasted secrets, new import cycles. The
agent cannot grade an edit before it writes it. Many `nextAction` strings are orders, not facts.

## What changes

Fold-ins first (facts that already exist):

- **Breaking exports.** Compose `handleCertifyPublicSurface` (`public-surface.ts`) against the
  receipt's base. Each breaking or potentially-breaking export becomes an item with its rule code and
  the consumers it breaks.
- **Contract breaks and parity.** Compose the verdicts of `handleCertifyServiceContract`
  (`service-contract.ts`): `contract-breaking`, `contract-declared-unimplemented`,
  `contract-implemented-undeclared`. Today only `contract-payload-missing-required` is folded in.
- **Env keys still set.** Project `blast_radius`'s `envDeclarations.stillSet` (an env read the diff
  removed that a Dockerfile, Kubernetes, or Terraform site still sets) as items naming file and line.

New diff-scoped findings (registered, advisory):

- **Architecture rules, new violations only.** From `handleCheckArchitecture` (`architecture.ts`),
  only violations whose edge the diff adds.
- **`secret-added`.** The patterns in `secret-redaction.ts` run over added lines only. The item names
  file, line, and pattern class, never the value. A safety net, not a scanner.
- **`cycle-introduced`.** `detectDependencyCycles` (`dependency-graph.ts`) at base and after; only a
  new cycle is reported, with its files in order.

Receipt shape and inputs:

- **`nextAction` as facts.** Reword the imperative strings in `verify-change.ts` as facts that name
  the check, file, or consumers (decision 8e95746d, neutral wording for pushed text).
- **Versioned receipt.** Add a `schemaVersion` field. Existing fields keep their names.
- **`staged` input.** An optional boolean on the existing tool: grade the staged diff instead of the
  working tree.
- **Bad base.** Decide and record whether an explicitly requested base that does not resolve is
  fatal or stays a disclosed fallback (today: disclosed fallback through `baseRefFallback`).
- **Speculative `patch` input.** An optional unified diff applied in memory to the working-tree
  files. The tool builds the graph through the hash-keyed Pass-1 cache and returns the same receipt,
  marked `speculative: true` with the patched files. It never writes to disk. A hunk that does not
  apply, a path outside the include patterns, or a patch over the file cap fails with the reason.

**The before-stop receipt speaks to the agent** (roadmap item `stop-hook-speaks-to-agent`). Today
the before-stop hook prints the receipt as a `systemMessage` (`hook.ts`), so the user sees it, and
the model sees it only when `enforcement.policy` blocks. This change also makes the receipt reach the
agent as context, and keeps it quiet when no item is new since the last stop. The design is a later
task.

## What does not change

- No new MCP tool, preset, or CLI command. `verify_change` and its fields keep their names.
- Advisory by default. Blocking stays opt-in through `enforcement.policy`.
- Local only. No network calls, no LLM. The tool runs no tests and edits no files.
- Works without OpenSpec: spec drift is one item family among many; every other family needs only
  code, tests, and git.

## Limits we disclose

- Each composed check keeps its own limits (for example, public-surface signatures cover
  TypeScript, JavaScript, and Python only). A check that fails is a boundary, never "no findings".
- The receipt is capped at 25 items; the omitted count is disclosed.
- `secret-added` uses OpenLore's own patterns; it misses what they miss.
- A speculative patch is graded against the current index; index staleness is disclosed as today.

## Depends on

Shipped code only: `verify-change.ts`, `public-surface.ts`, `service-contract.ts`, `blast-radius.ts`,
`architecture.ts`, `secret-redaction.ts`, `dependency-graph.ts`, `hook.ts`.

## Cut (not doing)

- `openlore verify-change [--base] [--staged] [--json]` CLI command: a new surface; the MCP tool and the before-stop hook already deliver the receipt.
- Opt-in pre-landing (pre-commit) gate hook, and `openlore enforce` running `verify_change`: a new surface; the before-stop hook already blocks under `enforcement.policy`.
- CLI and gate-hook tests: they follow the two cut surfaces.
