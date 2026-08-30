# ADR-0032: Persist stale-region composition in the edge store

## Status

accepted

**Domains**: analyzer, mcp-handlers

## Context

The stale file set and its structural composition must describe the same graph generation for watcher and read-time freshness consumers; storing them in one SQLite transaction avoids parallel-file drift.

## Decision

The system SHALL persist stale files and their structural composition atomically in the SQLite edge store for each graph generation.

## Consequences

The stale receipt schema gains composition metadata, closure ordering remains a pure helper over resident node facts, and full rebuild or clear removes both stale files and composition together.

> Recorded by openlore decisions on 2026-08-30
> Decision ID: fda1fc53
