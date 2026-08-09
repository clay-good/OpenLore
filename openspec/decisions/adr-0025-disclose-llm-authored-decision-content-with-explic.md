# ADR-0025: Disclose LLM-authored decision content with explicit provenance

## Status

accepted

**Domains**: mcp-security, cli, mcp-handlers

## Context

Approval surfaces must distinguish text extracted or rewritten by an LLM from agent-recorded decisions so reviewers deliberately approve untrusted content.

## Decision

The system SHALL label each pending decision with an explicit provenance field indicating whether its content was LLM-authored or agent-recorded, and surface that label in all approval interfaces.

## Consequences

Pending decisions gain an additive provenance field, extraction and consolidation set it, and CLI/MCP approval payloads display it.

> Recorded by openlore decisions on 2026-08-09
> Decision ID: 07df3189
