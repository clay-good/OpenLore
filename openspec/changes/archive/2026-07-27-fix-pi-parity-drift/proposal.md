# Fix MCP↔Pi parity drift: decision-current, missing conclusion tools, a two-direction guard

> Status: PROPOSED (2026-07-03, e2e audit follow-up). The project's parity doctrine says the same
> structural capabilities ship through both surfaces (MCP tools and the Pi extension), with
> deviations stated. Verified drift: Pi's `verify_claim` cannot express `decision-current` at all,
> six recently-shipped conclusion tools never reached Pi's `NAV_TOOLS`, and the only parity test
> guards one direction — so every new MCP tool silently drifts out of Pi. Fix the two concrete
> gaps and, the durable part, add a two-direction parity guard so future drift fails CI.

## The gap

- **Pi cannot verify decision authority.** Pi's `verify_claim` `kind` enum is
  `['calls','reaches','dead','impacts','safe-to-change']` (`src/pi/extension.ts:606`), omitting
  `decision-current` — which the MCP handler fully supports (`ClaimKind` at
  `src/core/services/mcp-handlers/claim-verification.ts:60-63`), the daemon dispatches
  (`src/core/services/tool-dispatch.ts:349-352`), and the `verify` preset explicitly advertises
  ("or a decision-authority claim (decision-current)", `src/cli/commands/mcp.ts:2170-2172`). A Pi
  agent about to cite an ADR has no way to catch a superseded decision before it reaches the human.
- **Six conclusion tools drifted out of Pi.** `NAV_TOOLS` (`extension.ts:494-864`, 36 tools) lacks
  `find_clones`, `analyze_error_propagation`, `analyze_env_impact`, `certify_public_surface`,
  `get_style_fingerprint`, and `briefing_since` — all dispatchable
  (`tool-dispatch.ts:373-395`) and all classified `conclusion` in
  `src/core/services/mcp-handlers/tool-contract.ts` (`:65-67`, `:115-117`). This is drift, not
  scoping: NAV_TOOLS already carries peer conclusion tools of the same class
  (`get_refactor_report`, `extension.ts:671`), and the file comment claims the surface "already
  supersets the MCP `substrate` preset" (`extension.ts:11-14`). Honest scope: 35 of the 70
  conclusion tools are absent overall — many plausibly deliberate (opt-in federation/coordination
  preset tools, inventories, generators) — but nothing records any of those judgments; the six
  named are the recent ships whose peers are already present.
- **Root cause: the guard is one-directional.** The only parity test asserts
  `NAV_TOOLS ⊆ dispatchable` (`src/pi/extension.test.ts:297-301`) — it catches a Pi tool the
  daemon can't dispatch, but never the reverse. Every new MCP conclusion tool ships green while
  silently absent from Pi. The doctrine ("if parity is intentionally skipped, say why") has no
  enforcement.

## What changes

- **(a) `decision-current` joins Pi's enum** at `extension.ts:606`, with the guideline updated to
  cover the decision-citation trigger (subject = 8-char decision id), matching the MCP tool's
  contract.
- **(b) A per-tool inclusion decision for the six.** Default: conclusion tools of a class already
  represented in NAV_TOOLS are included (all six qualify); any deliberate omission instead goes on
  the exclusion list with a stated reason.
- **(c) The durable part — a two-direction parity guard.** A named, commented
  `PI_EXCLUDED_TOOLS`-style exclusion list beside `NAV_TOOLS`, and a test asserting every
  dispatchable conclusion tool (per `TOOL_OUTPUT_CLASS`) is either in `NAV_TOOLS` or on that list.
  A new MCP conclusion tool now fails CI until its author makes the Pi decision explicitly — the
  same fails-until-you-classify discipline `tool-contract.test.ts` already enforces for output
  class and capability family. The existing 35 absences get one-line reasons at introduction
  (federation/coordination = opt-in preset surface; inventories = injection covers them; etc.).
- **One-line cleanup (task, not a requirement):** `interference-map.ts` line 391 embeds a literal
  NUL byte in a template literal (`` `${repo}<NUL>${w.filePath}` ``, byte offset ~19335) — it trips
  grep/rg into binary mode (the same class as the known `analysis.ts` `\x00` gotcha). Replace the
  raw byte with the `'\x00'` escape sequence; behavior identical.

## Why this is in scope

The parity doctrine is already written down (project CLAUDE.md, "MCP tool ↔ Pi extension parity")
and already being violated silently — the definition of the drift this audit closes. The concrete
gaps deny Pi agents capabilities the substrate advertises (decision-authority verification most
sharply), and the guard converts a prose doctrine into a CI invariant using an established
precedent.

## Impact

- Files: `src/pi/extension.ts` (enum + six NAV_TOOLS entries + exclusion list),
  `src/pi/extension.test.ts` (two-direction guard),
  `src/core/services/mcp-handlers/interference-map.ts` (NUL escape).
- Specs: `mcp-quality` — 1 ADDED requirement (PiSurfaceParityIsGuarded).
- Tool surface: MCP unchanged (no new tool, no payload-budget impact); Pi gains six native tools +
  one enum member. Pi tool descriptions stay trigger-first per the NAV_TOOLS house style.
- Risk: low. Additive on the Pi side; the guard may surface latent param-subset mismatches for the
  six new entries (the existing `extension.test.ts:303-314` subset test covers that at authoring
  time).
