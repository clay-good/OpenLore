# ADR-0024: Share identifier tokenization through a dependency-light module

## Status

accepted

**Domains**: analyzer, cli

## Context

The injection relevance gate must use the same identifier-aware tokenization as BM25 while the Pi host must not import the analyzer-backed vector index. Extracting the pure tokenizer into a dependency-light module preserves one tokenization contract without loading analyzer dependencies.

## Decision

Share identifier tokenization through a dependency-light module

## Consequences

The vector index re-exports the tokenizer for compatibility, while injection and Pi consume the lightweight implementation directly.

> Recorded by openlore decisions on 2026-08-09
> Decision ID: b9a5481b
