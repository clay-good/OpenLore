# ADR-0033: Reuse watcher repository-delta semantics for ancestor bundle catch-up

## Status

accepted

**Domains**: cli, analyzer

## Context

Clean ancestor bundle imports must apply Git changes through the same closure, rebinding, budget, and stale-region behavior as live watcher updates while keeping validation and diverged rebuild behavior unchanged.

## Decision

The system SHALL apply clean ancestor bundle catch-up changes through the same repository-scoped watcher mutation path used for live updates.

## Consequences

McpWatcher exposes a repository-scoped delta method that import invokes against validated staging; the shared boundary remains the watcher mutation lane and no second incremental algorithm is introduced.

> Recorded by openlore decisions on 2026-08-30
> Decision ID: fbf129f7
