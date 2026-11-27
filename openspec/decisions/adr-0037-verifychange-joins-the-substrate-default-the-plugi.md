# ADR-0037: verify_change joins the substrate default; the plugin preset is a subset of substrate with no spec-generation tool

## Status

superseded by ADR-0039 (decision f7faf32c, 2026-11-27)

> `verify_change` did not join `substrate`: its benchmark gate is not doing. ADR-0039 records what
> shipped. This ADR is kept as the historical record.

**Domains**: 

## Context

Owner decision 2026-11-14: every MCP user gets the closing check of an edit, gated by the default-surface benchmark protocol (fallback: plugin keeps verify_change, substrate unchanged). The plugin carries deterministic evidence tools only; prepare_spec_generation and prepare_spec_repair stay in substrate and full but not in plugin. Planned in reframe-governance-as-agent-evidence.

## Decision

verify_change joins the substrate default; the plugin preset is a subset of substrate with no spec-generation tool

## Consequences



> Recorded by openlore decisions on 2026-11-14
> Decision ID: 66b3c425


