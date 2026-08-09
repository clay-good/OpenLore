# ADR-0026: Support exactly four tool-confined local analysis agent families

## Status

accepted

**Domains**: llm

## Context

PR 337 needs subscription-backed analysis through Codex, Claude Code, the Google Gemini family (Gemini CLI and Antigravity CLI), and Cursor while keeping repository content inside prompt boundaries and project-neutral execution. Codex CLI and Antigravity CLI become selectable no-key providers.

## Decision

The system SHALL harden four subscription-backed local analysis agent families (Codex, Claude Code, Gemini/Antigravity CLI, and Cursor) with their strongest noninteractive restricted-permission controls and prompt boundaries. Existing non-agent local model providers are outside this four-family count.

## Consequences

Every supported agent invocation uses its strongest noninteractive restricted-permission controls. No additional agent family is added in this PR; the existing Mistral Vibe provider remains separately supported.

> Recorded by openlore decisions on 2026-08-09
> Decision ID: e89b006a
