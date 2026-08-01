# System Overview

## Purpose

OpenLore is persistent, deterministic, local-first memory and guardrails for AI coding agents, with
no LLM in the hot path. It is a CLI and embeddable library that gives an agent statically-computed
structural context about a codebase — the call graph, spec corpus, architectural decisions, and
code-anchored memory — so the agent can orient, reason about blast radius, and check its work
without re-reading the repository file by file. Every capability is grounded in static analysis
(tree-sitter parsing, a persisted call graph, git history) rather than LLM inference; an LLM is
used only where generation is unavoidable (spec authoring), never in the retrieval or guardrail
path and never to fabricate structure.

OpenLore is one substrate with two faces: **navigation** (read the graph — orient, search, trace,
map) and **governance/memory** (anchor facts, record decisions, weigh changes against the graph).
Both faces share one graph, one anchored-fact store, and one freshness lease. It is distinct from
OpenSpec, the spec-driven-development format whose `openspec/` layout OpenLore reads and writes;
OpenLore delegates the change lifecycle (proposal → archive) to the `openspec` CLI rather than
reimplementing it.

## Domains

This system is organized into the following domains (each link resolves to a spec on disk):

| Domain | Description | Spec |
|--------|-------------|------|
| Analyzer | Parses the codebase into a persisted call graph, signatures, imports, CFG/def-use overlays, type inference, and structural metrics; the substrate every other domain reads. | [spec.md](../analyzer/spec.md) |
| Api | The programmatic (embeddable) API exposed by `src/api/` — in-process functions (`init`, `analyze`, `generate`, `drift`, `run`) a host process calls to drive OpenLore. | [spec.md](../api/spec.md) |
| Architecture | The layered architecture, the unified structural substrate, and the six closed capability families every MCP tool declares. | [spec.md](../architecture/spec.md) |
| Cli | The `openlore` command surface (analyze, orient, mcp, install, decisions, drift, status, …) and its progress/output rendering. | [spec.md](../cli/spec.md) |
| Config | Reads, writes, and merges `.openlore/config.json` and `openspec/config.yaml`, including directory setup and the spec-store binding. | [spec.md](../config/spec.md) |
| Drift | Detects spec/code drift between changes and the spec corpus, and computes memory/decision staleness against git history. | [spec.md](../drift/spec.md) |
| Generator | Generates OpenSpec-formatted specifications and mapping artifacts from analysis results. | [spec.md](../generator/spec.md) |
| Llm | A unified interface over LLM providers (Anthropic, OpenAI-compatible, Gemini, CLI-backed providers) used for the generation paths, with a mock provider for tests. | [spec.md](../llm/spec.md) |
| Mcp-handlers | The MCP tool handlers (orient, search, subgraph, blast_radius, recall, verify_claim, …) plus the shared directory/path/error utilities they use. | [spec.md](../mcp-handlers/spec.md) |
| Mcp-quality | The MCP tool-surface contract: capability families, conclusion-over-graph output, tool-count/preset guards, and the epistemic-lease weighting. | [spec.md](../mcp-quality/spec.md) |
| Mcp-security | Hardening of the local HTTP surfaces — the MCP serve daemon and view server — against DNS rebinding and untrusted-descriptor SSRF. | [spec.md](../mcp-security/spec.md) |
| Openspec | Compatibility and validation of OpenSpec configurations and spec structure (config load/save/validate, markdown/heading checks). | [spec.md](../openspec/spec.md) |
| Project | Detects the project type of an analyzed repository and maps each type key to its display name. | [spec.md](../project/spec.md) |
| Verifier | Verifies the accuracy of a generated spec against the codebase by analyzing file purposes, imports, exports, and requirement coverage. | [spec.md](../verifier/spec.md) |

## Technical Stack

- **Type**: Command-line tool and embeddable TypeScript library
- **Primary Language**: TypeScript (Node.js)
- **Code Parsing**: tree-sitter (25+ languages); see the language-support matrix
- **Search**: BM25 keyword index by default; optional on-device or remote embeddings for semantic ranking
- **Persistence**: SQLite-backed EdgeStore for the call graph; LanceDB for vector indexing
- **Testing**: Vitest
- **Architecture**: Layered (CLI → API → service → analyzer → repository)

## Requirements

### Requirement: NorthStarIsADeterministicStructuralContextSubstrateForCodingAgents

The system SHALL provide deterministic, locally-computed structural context as a substrate for coding agents, grounding all capabilities in static analysis rather than LLM inference.

> Decision recorded: c6d1ad07
> Date: 2026-06-01

#### Scenario: Capabilities are grounded in static analysis

- **WHEN** any capability serves structural context to an agent
- **THEN** the answer is computed deterministically and locally from static analysis, with no LLM in the retrieval or guardrail path

## Technical Notes

- **Architecture Style**: Layered architecture — CLI interface → API layer → service layer → analyzer → repository/store — chosen for clear separation of concerns and a single structural substrate shared by both faces.
- **Security Model**: No user authentication; OpenLore is a local-first CLI/library. Credentials appear only as LLM-provider API keys read from the environment. The optional MCP serve daemon and view server bind to loopback and are guarded against DNS rebinding; a request may carry an optional `x-openlore-token`.
- **External Integrations**: Git, LLM providers (Anthropic, OpenAI-compatible, Gemini), LanceDB for vector indexing, tree-sitter for code parsing, the `openspec` CLI for the change lifecycle.

## Decisions

### North star is a deterministic structural context substrate for coding agents

**Status:** Approved
**Date:** 2026-06-01
**ID:** c6d1ad07

OpenLore is positioned as local-first plumbing (like tree-sitter/SCIP/LSP) that agents build on, not a breadth product; every capability is additive to the coding-agent use case and grounded in static analysis rather than LLM guessing (Spec 13).

**Consequences:** Features must make the coding-agent case more useful or they do not ship; retrieval stays token-scoped and local-first.
