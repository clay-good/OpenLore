# ADR-0034: Pi starts with the substrate tool surface and on-demand tool groups

## Status

accepted

**Domains**: 

## Context

Parity with the Claude Code default (ADR-0023): a Pi session activates only the substrate preset tools plus openlore_configure and openlore_activate_tools, which turns on task groups (specs, memory, review, quality, inspect) on demand. This reverses the earlier position that presets are an MCP-only concept Pi does not use, and cuts standing context for local models. pi.toolSurface: all keeps every tool active.

## Decision

Pi starts with the substrate tool surface and on-demand tool groups

## Consequences

Non-substrate Pi tools are registered but inactive until activated; each activation changes the tool list once (prompt cache miss). A test keeps the Pi lean set equal to TOOL_PRESETS.substrate.

> Recorded by openlore decisions on 2026-09-15
> Decision ID: 848b360d


