# ADR-0035: Focus OpenLore on the verification-governance moat and cross-harness interop

## Status

accepted

**Domains**: 

## Context

Market research (2026-10): Claude Code and Codex still ship no persistent codebase index — they grep or clone-per-task — so a deterministic, local-first structural substrate (call graph, blast radius, spec drift, no-LLM memory with provenance) fills a real gap for them. But the retrieval half of that is commoditizing (Serena, CodeGraph/code-review-graph, managed context engines such as Augment/Greptile/Cody), and the IDEs are absorbing the context+memory layer outright (Cursor's always-on index, Antigravity's native Knowledge Items). OpenLore's durable, hard-to-replicate value is the deterministic (no-LLM) verification/governance plus provenance-tracked memory substrate on one graph, and interop so it augments whatever harness the user runs rather than competing with it. Breadth — full per-language Kotlin support, speculative conclusion tools — dilutes focus and re-bloats a tool surface already shrunk to a lean default (ADR-0023).

## Decision

Focus OpenLore on the verification-governance moat and cross-harness interop

## Consequences

The 22 Kotlin changes and three narrow/speculative proposals (`add-notebook-cell-graph`, `add-line-provenance-evidence`, `add-render-guard-index`) are archived as won't-do (preserved in `openspec/changes/archive/2026-10-24-*`). A root `ROADMAP.md` sequences the BUILD tier — interop (`adopt-agent-context-interop` with AGENTS.md/SKILL.md plus a slimmed injected digest, `add-scip-index-interchange`, `add-lsp-evidence-tier`, `adopt-mcp-tasks-and-cache-hints`, `add-structural-search-tool`) and moat (`add-callgraph-soundness-calibration`, `add-dependency-impact-analysis`, `add-vuln-reachability-triage`, `add-store-origin-provenance`) — ahead of a DEFER tier of breadth proposals that stay open but need a concrete user need to promote. Normative domain specs are untouched; future work stays as change proposals, folded into the specs only at archive time.

> Recorded by openlore decisions on 2026-10-24
> Decision ID: 225084d7
