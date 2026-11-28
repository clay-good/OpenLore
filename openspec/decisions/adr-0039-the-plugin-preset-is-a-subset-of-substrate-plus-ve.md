# ADR-0039: The plugin preset is a subset of substrate plus verify_change, with no spec-generation tool; verify_change stays out of substrate

## Status

accepted

**Domains**: mcp-quality

## Context

ADR-0037's title says `verify_change` joins the `substrate` default. That step was gated on a
benchmark run that the owner set to "not doing" (ROADMAP owner answers, 2026-11-14). What shipped
(#748, presets in `src/cli/commands/mcp.ts`): `substrate` has 15 tools without `verify_change`;
`plugin` has 11 evidence tools, including `verify_change`, and no `prepare_spec_*` tool. The
record must match the code.

## Decision

The plugin preset is a subset of substrate plus verify_change, with no spec-generation tool; verify_change stays out of substrate

## Consequences

`verify_change` reaches MCP users through the `plugin` preset, `--preset full`, Pi, and the
before-stop hook. Adding it to `substrate` needs a new decision with evidence from daily use
(evidence yield), not the cut benchmark.

> Recorded by openlore decisions on 2026-11-27
> Decision ID: f7faf32c
> Supersedes: 66b3c425
