# Standing context cost: measure the tax the surface charges before it answers anything

> Status: BUILT (2026-08-23). The deterministic measurement, source-declared budgets,
> guarded baselines, delivery guidance, and CLI/MCP semantic-parity registry are implemented and
> verified through five adversarial review loops plus the full local CI matrix. OpenLore counts its tools and caps a
> serialized byte prefix, but never measures the thing that actually matters: the **tokens every
> session pays** to load a preset's descriptions and schemas before a single question is asked. A
> knowledge server that costs 20,000 tokens to have available is part of the context problem it was
> built to solve. Prior art: engines that measure the standing surface deterministically, hold it
> under a declared budget as a CI regression gate, and treat the command-line as an equal,
> zero-standing-cost delivery path.

## The gap

- **The budget is a target, not a measurement.** `mcp-quality`'s Description Quality and Token
  Budget requirement states a per-tool target of roughly 200 tokens for the description portion.
  Nothing measures it. Nothing measures the aggregate. A description edit can inflate every session
  in the fleet and no check notices.
- **The one hard number is a byte prefix, not a token cost.** `mcp-presets.test.ts` caps the
  `tools/list` serialized prefix, and the repo's own comment trail records that ceiling being
  consciously raised three times (84,000 → 86,000 → 88,000). A ceiling that moves whenever it is
  reached is a record of growth, not a constraint on it — and bytes are not what the model is
  charged for.
- **Presets are the product's answer to surface cost and are unmeasured.** OpenLore's whole
  progressive-disclosure story is that `substrate` is small and `full` is opt-in. "Small" is
  currently an assertion. The `substrate` default was chosen on benchmark evidence for *selection
  accuracy* (ADR-0023); its *standing cost* was never part of that evidence, so half the trade-off
  was decided on feel.
- **The zero-cost path is undersold and unguarded.** Several conclusion tools have CLI twins. A CLI
  spends nothing until it is invoked — strictly cheaper than MCP for scripted agents, CI jobs, and
  pipeline grounding. The docs treat it as a convenience rather than a first-class delivery choice,
  and nothing pins the two faces together: `PiSurfaceParityIsGuarded` covers MCP↔Pi, and
  `conclusion-honesty-parity.test.ts` covers staleness disclosures, but no guard says a CLI
  conclusion and its MCP twin carry the same conclusion.

## What changes

1. **Measure the standing cost, per preset, deterministically.** A test computes the token cost of
   each preset's exact served `tools/list` payload — including schemas and annotations — with a
   fixed, offline tokenizer approximation that is stated and version-pinned. No model call, no
   network. The number is a property of the registry, so it is byte-stable.

2. **Declare a budget per preset and fail CI on inflation.** Each preset carries a declared token
   budget in the same source-declared style as `TOOL_PRESETS` itself. Exceeding it fails the build.
   Raising a budget is a deliberate, reviewed edit with its justification in the same commit — the
   opposite of a ceiling that drifts up to meet whatever the code did.

3. **Publish the measured numbers and guard the published claim.** The measured standing cost of
   each preset is documented, and the doc-claim guard (`doc-claim-sync.test.ts`) asserts the
   published number equals the measured one. This is the discipline the repo already applies to
   tool counts; it extends to the number that actually costs the user something.

4. **The command-line is a declared first-class, zero-standing-cost delivery path.** The docs state
   the trade-off plainly — MCP when the agent decides *when* to retrieve mid-conversation, CLI when
   the agent can shell out and wants to pay nothing until it does — and state that neither is
   deprecated in favour of the other.

5. **A CLI↔MCP semantic-conclusion parity guard.** For every conclusion capability exposed on both
   faces, the common input projection SHALL produce the same successful pre-transport conclusion,
   including disclosed boundaries and staleness signals. One implementation, two renderings. The
   registry declares face-only capabilities and input controls. Protocol error envelopes and MCP's
   transport byte cap remain transport concerns rather than semantic conclusions.

## Why this is in scope

`mcp-quality` already owns tool-surface size, progressive disclosure, and output token budgeting.
The input side — the standing cost of merely having the surface available — is the one budget in
that domain that is asserted rather than measured, and it is the one paid on every session
regardless of whether a tool is ever called. With 73 tools in the registry and a stated strategy of
growing the registry while holding the default constant, the measurement is what makes the strategy
checkable instead of aspirational.

## Impact

- **Files:** a standing-cost measurement module and its budgets beside `TOOL_PRESETS`, a CI budget
  test extending `mcp-presets.test.ts`, a documented per-preset cost table guarded by
  `doc-claim-sync.test.ts`, and a CLI↔MCP conclusion-parity test enumerating the paired
  capabilities.
- **Specs:** `mcp-quality` — 2 ADDED requirements (measured standing surface budget; dual-face
  delivery with conclusion parity).
- **Tool surface:** unchanged — this measures the surface, it does not alter it. The measurement
  may reveal that a preset is already over a sensible budget, in which case trimming descriptions
  is follow-on work, scoped by the number this change produces.
- **Risk:** low. The tokenizer approximation is the one judgment call; it is stated, version-pinned,
  and used only for a relative regression gate, so approximation error cannot make the gate
  dishonest as long as it is consistent.
- **Sibling boundaries:** `refine-orient-context-budgeting` owns the size of a *response*; this owns
  the size of the *surface*. `add-benchmark-harness-protocol` owns selection-accuracy evidence for
  default-surface decisions; this supplies the cost half of that trade-off, which ADR-0023 decided
  without it.

## Measured baseline

The first `utf8-bytes-div-4-v1` run over `origin/main` at `cf5be19e` measured the exact served
`tools/list` result, including annotations: `minimal` 2,736; `navigation` 3,533; `memory` 1,216;
`verify` 1,262; `federation` 3,837; `coordination` 2,487; `substrate` 5,131; and `full` 24,140
estimated tokens. The source-declared ceilings retain 5.6%–7.8% headroom. These are regression
units, not provider-specific billing claims.
