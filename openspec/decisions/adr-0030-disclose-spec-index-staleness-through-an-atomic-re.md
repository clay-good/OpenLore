# ADR-0030: Disclose spec index staleness through an atomic receipt

## Status

accepted

**Domains**: analyzer, mcp-handlers

## Context

The approved spec permits incremental rebuilding or honest staleness disclosure. A bounded receipt avoids rebuilding the full spec index on every edit while making stale results explicit across processes.

## Decision

The system SHALL atomically track spec changes and index build time, disclose bounded freshness metadata in spec search results, and clear the staleness receipt after a full analysis.

## Consequences

The watcher atomically records the exact changed spec files and the last index build time; search_specs returns bounded freshness metadata, and a full analysis resets the receipt.

> Recorded by openlore decisions on 2026-08-30
> Decision ID: 58cd7afe
