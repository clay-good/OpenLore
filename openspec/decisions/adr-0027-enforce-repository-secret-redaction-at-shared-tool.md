# ADR-0027: Enforce repository secret redaction at shared tool dispatch

## Status

accepted

**Domains**: mcp-security, llm, config

## Context

Both stdio MCP and HTTP/Pi paths converge on dispatchTool, so extending the existing dependency-free redactor there protects all source-carrying tool outputs without duplicating transport logic.

## Decision

The system SHALL redact repository secrets from all source-carrying tool outputs at shared dispatch by default while allowing trusted operators to opt out through configuration.

## Consequences

The four source-carrying tools are redacted by default with typed, counted disclosure; trusted operators may opt out through configuration; existing error and telemetry redaction APIs remain compatible.

> Recorded by openlore decisions on 2026-08-09
> Decision ID: 2d0457b5
