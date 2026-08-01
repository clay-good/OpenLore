# One default, said once: align every surface with the substrate default (ADR-0023)

> Status: SHIPPED (2026-07-18, PR #229; status reconciled 2026-07-19). Originally proposed (2026-07-03, e2e audit). The ADR-0023 flip made `substrate` (13 tools) the
> out-of-box default, but the flip's blast radius was under-applied: user-facing help strings,
> one doc page, several docstrings — and one real code path (`openlore serve`) — still say or
> implement `navigation`. This change fixes every stragglers and adds the guard that keeps the
> default's name from ever forking again. No behavior change except the `serve` default.

## The gap

Ground truth: `LEAN_DEFAULT_PRESET = 'substrate'` (`constants.ts:222`), asserted by
`mcp-presets.test.ts:78-80`, and live-confirmed by the CLI audit (`mcp --list-tools` → "substrate
(13 tools, 4 families)"). Contradicted by:

| Where | Says | Kind |
|---|---|---|
| `src/cli/commands/mcp.ts:2714-2715` (`--preset` help) | "Default (no preset) is the lean *navigation* surface … NOT the full registry" | user-facing false claim |
| `src/cli/install/index.ts:297` + `src/cli/commands/connect.ts:76` | "Default (no preset) wires the lean navigation surface" | user-facing false claim |
| `src/cli/install/adapters/claude-code.ts:31-32` | "the benchmark-winning navigation core" (adapter actually emits substrate at `:39`) | stale comment |
| `docs/mcp-tools.md:44` | "`--preset navigation` … **now the default** … 10 tools" — while line 63 (correctly) says substrate is now the default | self-contradicting doc |
| `src/cli/commands/serve.ts:347` | `options.preset ?? 'navigation'` — **hardcoded**, so `openlore serve` defaults to 10 tools while `openlore mcp` defaults to 13 | real divergence |
| `src/cli/commands/serve.ts:11`, `:488` ("~60 tools"), `mcp.ts:2233-2234`, `:2289-2298`, `:2196-2205` | assorted stale docstrings from before the flip | internal drift |
| top-level CLI help | `mcp` blurb "(lean by default)" | vague post-flip |

The `leanDefaultActive` docstring (`mcp.ts:2289-2298`) is behaviorally misleading too: it promises
that an explicit `--preset navigation` gets the same breadth-pointer treatment as the default,
which stopped being true when the default moved.

## What changes

1. **`serve` imports `LEAN_DEFAULT_PRESET`** instead of the hardcoded `'navigation'`, so both
   entry points share one default forever. (If the split were intentional it is documented
   nowhere; the CLI audit flagged it as an inconsistent story across surfaces.)
2. Every help string, adapter comment, docstring, and doc line in the table above is corrected to
   name `substrate` as the default and `navigation` as the one-flag lean escape; stale tool counts
   in comments become derived or approximate-free text.
3. **Drift guard:** a test asserts that the string `LEAN_DEFAULT_PRESET` (the constant, not a
   literal) is the only source of the default in `mcp.ts`, `serve.ts`, `connect.ts`, and the
   install adapters — i.e. no call site may hardcode a preset-name literal as a fallback default —
   and that user-facing `--help` output for `mcp`/`install`/`connect` names the active default
   preset by interpolating the constant (the pattern `mcp.ts` already uses for
   `${TOOL_DEFINITIONS.length}`).

## Why this is in scope

The default surface is the product's front door; ADR-0023 was benchmark-gated precisely because it
matters. Telling users the default is something it isn't fails the honesty contract at the first
`--help` they ever read. The guard makes the *next* default flip a one-constant change.

## Impact

- `mcp.ts`, `serve.ts`, `connect.ts`, `install/index.ts`, install adapters, `docs/mcp-tools.md`;
  one new drift-guard test.
- Sibling: `reconcile-substrate-write-face` edits the same help strings for a different reason
  (the "both faces" wording); land together or rebase the later one.
- Specs: `cli` — 1 ADDED requirement (DefaultPresetHasOneSource).
- Risk: `openlore serve` gains 3 tools by default (navigation → substrate) — the same surface
  `openlore mcp` already serves; disclosed in CHANGELOG.
