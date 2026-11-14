# ADR-0036: Deliver deterministic evidence to the agent at hook moments, not new tools

## Status

accepted

**Domains**: 

## Context

Owner direction 2026-11-14: OpenLore should serve the agent through Claude Code hooks (prompt submitted, before an edit, after an edit, before stop) and stay simple, always on and local. Breadth tools and integrations from ADR-0035's BUILD tier add surface the agent must learn and the owner must maintain; the same value reaches the agent better as proof-carrying findings on existing answers (orient, blast_radius, verify_change, verify_claim, recall) at the moment it can act. Spec frameworks: OpenSpec stays first-class, but no feature may require OpenSpec or its CLI.

## Decision

Deliver deterministic evidence to the agent at hook moments, not new tools

## Consequences

No new MCP tools, integrations, services or network calls; no LLM in the hot path; no separate UI; enforcement stays off by default. Existing tools keep their names (no renames, no aliases); tools hidden from the plugin's default set stay available through presets, MCP and Pi, and the MCP-Pi parity guard keeps passing. Cut work is deleted from openspec/changes and listed with a restore commit in ROADMAP.md's Not doing table. Supersedes ADR-0035; ROADMAP.md names the build order.

> Recorded by openlore decisions on 2026-11-14
> Decision ID: b30f08a9
> Supersedes: 225084d7


