# ADR-0028: Scope cold-read repair to active repository hosts

## Status

accepted

**Domains**: mcp-handlers, analyzer, drift

## Context

One-shot CLI and plain MCP reads must disclose stale cited files without spawning work, while --watch-auto and serve may schedule repair. A canonical-root keyed host registry makes repair authority explicit, prevents one host from repairing another repository, and lets the freshness helper remain dependency-light.

## Decision

Scope cold-read repair to active repository hosts

## Consequences

Watcher and serve lifecycles register and dispose exact-root repair callbacks. Cold-read checks pass only cited stale files to the registered host and label repair scheduled only when that host accepts the request. Plain MCP and one-shot CLI remain disclosure-only.

> Recorded by openlore decisions on 2026-08-09
> Decision ID: 84eb98ed
