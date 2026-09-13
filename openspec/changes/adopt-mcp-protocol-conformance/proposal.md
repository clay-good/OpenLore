# Adopt MCP protocol conformance: guarded annotations, output schemas, actionable errors, elicitation

> Status: BUILT (2026-09-12), narrowed — see *Scope as built*. Originally PROPOSED (2026-07-03, e2e audit). Brings the MCP surface up to the now-standard protocol
> features it is ideally placed to use — all local, all deterministic, no behavior change to any
> conclusion. Prior art: the MCP specification rev 2025-06-18
> (https://modelcontextprotocol.io/specification/2025-06-18) and SEP-1303 (tool-error shape).

## The gap

1. **Annotations exist but are unguarded.** `toolAnnotations` (`src/cli/commands/mcp.ts:2103-2110`)
   already emits `title`, `readOnlyHint`/`destructiveHint`/`idempotentHint` (`_RO`/`_RWI`/`_RW`,
   `:2055-2057`), `openWorldHint` (`OPEN_WORLD_TOOLS`, `:2089`), and the custom `family`. But the
   lookup falls back silently: `...(TOOL_ANNOTATIONS[name] ?? _RO)` (`:2106`). A future mutating
   tool omitted from the table is **advertised read-only** — the exact mis-advertisement the
   `mcp-security` *Write Confinement for Mutating Tools* requirement forbids. Nothing fails CI when
   a tool has no explicit entry (contrast: `tool-contract.test.ts` fails on a missing family).
2. **No `outputSchema`/`structuredContent` anywhere** (repo-wide grep: zero hits). Every tool
   returns JSON serialized into a text block. Deterministic conclusion tools are the ideal
   structured-output citizen (spec rev 2025-06-18): clients could validate and machine-consume
   `verify_claim` receipts or `blast_radius` briefings instead of re-parsing prose-wrapped JSON.
3. **Input-validation errors are protocol errors, not tool errors.** A malformed argument throws
   `McpError(ErrorCode.InvalidParams, ...)` (`mcp.ts:2474-2480`). Per SEP-1303, validation failures
   should be Tool Execution Errors (`isError: true`) with actionable fix text, because protocol
   errors are often swallowed by the host while tool errors reach the model, which can self-correct.
4. **The human-authorization invariant has no in-protocol transport.** `approve_decision` /
   `reject_decision` (`decisions.ts:222`, `:258`) require a human, but the gate rides CLAUDE.md
   prose ("present each decision to the user"). MCP elicitation (accept/decline/cancel) is a
   structured fit for exactly this approve/reject/defer flow.

## What changes

- **Annotation coverage guard** (`mcp-quality`): every tool in `TOOL_DEFINITIONS` MUST have an
  explicit `TOOL_ANNOTATIONS` entry; the `?? _RO` fallback is removed and a test (alongside
  `tool-contract.test.ts`) fails CI on a missing or read-only-mis-declared entry. No wire change
  for existing tools — this converts the emitted hints from convention to guarantee.
- **`outputSchema` + `structuredContent` for the 13-tool `substrate` preset first** (the default
  surface, where client-side validation pays most). Schemas are derived from the handlers' existing
  result shapes; results are additionally returned as `structuredContent` per spec rev 2025-06-18.
  Rollout is per-preset and budget-conscious: schemas count against the tools/list payload budget
  (`src/cli/commands/mcp-presets.test.ts:581-608`, full < 88k, substrate < 20k), so each bump
  follows the documented per-bump rationale discipline already in that file (`:569-580`).
- **Error-shape conformance (SEP-1303):** argument-validation failures become `isError: true` tool
  results whose text names the offending parameter, the expected shape, and a corrected example —
  so the model self-corrects instead of the host swallowing an `InvalidParams` protocol error.
  Genuinely malformed protocol frames stay protocol errors.
- **Elicitation as an opt-in transport for decision approval:** when the client advertises the
  `elicitation` capability, the decisions gate MAY surface pending decisions as elicitation
  requests (accept ≈ approve, decline ≈ reject, cancel ≈ defer). The human-authorization invariant
  is unchanged — elicitation answers come from the user, not the model; without the capability the
  existing prose flow remains, so nothing regresses.
- **WATCH item, no work now:** the 2026-07-28 RC direction (stateless core, `initialize` removal)
  is a disclosed forward-compat risk because OpenLore ships a **custom initialize handler**
  (`mcp.ts:2405-2424` — it shadows the SDK `instructions` option and reports the real package
  version). Recorded as a risk, revisited when the RC lands; not built against a moving spec.

Deliberately NOT borrowed from the protocol surface: server-initiated sampling (would put an LLM in
the hot path), `listChanged` (the tool list is static per session — advertising it would be
dishonest, per the existing comment at `mcp.ts:2413-2414`), and remote/HTTP transports (local-first).

## Scope as built

- **Built:** the annotation guard (no `?? _RO` fallback; a coverage test plus an audited
  read-only/mutating check), actionable `isError` validation errors with a corrected example call,
  and the WATCH comment on the custom initialize handler.
- **Deferred — `outputSchema` + `structuredContent`:** since this proposal, the default surface gained
  guarded standing-context token budgets (`STANDING_CONTEXT_BUDGETS`, at most 10% headroom over a
  measured baseline, published in `docs/mcp-tools.md`). Output schemas for the 15 `substrate` tools
  would be a large standing-cost increase on the surface ADR-0023 keeps lean, for a benefit no
  current client consumes. It needs its own measured change.
- **Deferred — elicitation for decision approval:** the decisions gate runs in a git pre-commit hook,
  outside any MCP session, so no in-flight MCP request exists to carry an elicitation when it fires.
  An approval flow inside `approve_decision` changes the human-authorization design and needs its own
  change.

## Why this is in scope

Pure conformance on an existing surface — no new capability, dependency, or LLM. Guarded
annotations serve the honesty contract (never advertise a mutator as read-only); actionable errors
serve `mcp-quality`'s agent-ergonomics discipline; structured content makes deterministic
conclusions machine-checkable instead of re-parsed. Nothing touches the default surface's tool
membership, so no benchmark is required (ADR-0023 governs membership, not encoding).

## Impact

- `src/cli/commands/mcp.ts` (annotations guard, error shape, initialize WATCH comment,
  elicitation wiring), `mcp-presets.test.ts` (budget bumps with rationale), schema derivation for
  the 13 substrate tools, a new annotation-coverage test.
- Specs: `mcp-quality` — 2 ADDED (StandardToolAnnotationsAreEmittedAndGuarded,
  SubstrateConclusionsCarryOutputSchemas); `mcp-handlers` — 2 ADDED
  (ValidationErrorsAreActionable, ElicitationRidesTheDecisionApprovalFlow).
- Risk: payload-budget growth from schemas (mitigated: substrate-first, per-bump rationale);
  client compatibility with `structuredContent` (mitigated: text content is still emitted, per
  spec); elicitation is capability-gated so non-supporting hosts see no change.
