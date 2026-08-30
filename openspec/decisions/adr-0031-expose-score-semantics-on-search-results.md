# ADR-0031: Expose score semantics on search results

## Status

accepted

**Domains**: analyzer, mcp-handlers

## Context

Code and spec searches can return BM25, cosine-distance, or reciprocal-rank-fusion scores whose numeric values are not directly comparable. Each result must name its score kind so clients can interpret and rank it honestly.

## Decision

The system SHALL identify the scoring method used for every code and specification search result without removing or changing the existing score field.

## Consequences

Every search_code and search_specs result includes scoreKind, including literal-text fallbacks and hybrid retrieval, without changing the existing score field.

> Recorded by openlore decisions on 2026-08-30
> Decision ID: 9eb51001
