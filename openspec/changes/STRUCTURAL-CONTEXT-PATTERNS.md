# Change set: structural-context patterns from a survey of comparable systems

This file groups five independent change proposals drawn from a competitive analysis of other
deterministic, local-first structural-memory / code-graph systems built for coding agents. None of
those systems is named here, by design — we adopt the *concept*, expressed in OpenLore's own terms,
not anyone's branding. Each proposal is independently shippable; together they close gaps where a
peer system does something OpenLore's substrate does not yet do, while staying inside OpenLore's
north star: *deterministic, locally-computed structural context as a substrate for coding agents,
grounding all capabilities in static analysis rather than LLM inference* (`overview/spec.md`,
decision `c6d1ad07`).

## The motivating observation

Surveying the field of "give a coding agent durable structural memory of a codebase," two design
families recur. One family is a pure-native (non-TypeScript) graph engine optimizing raw
indexing throughput and breadth of language coverage. The other is a bi-temporal, episode-aware
graph that treats the codebase's *evolution* and its *idioms* as first-class queryable structure.
OpenLore already matches or leads both on the parts that matter most to it — anchored self-
invalidating memory, a decisions/governance gate, spec drift, claim verification, blast-radius and
test-selection *conclusion* tools, and multi-repo federation. The gaps are narrower and specific:

| # | Gap a peer system fills that OpenLore does not | Borrowed concept (de-branded) | Primary domain |
|---|---|---|---|
| 1 | Agents edit in a style the codebase doesn't use, because they default to training priors | **Empirical idiom fingerprint** — deterministic per-language AST-idiom histograms the agent reads before editing | analyzer + mcp-handlers |
| 2 | Adding a language is orchestration work, not a data row; coverage is invisible | **Declarative language-support registry** — one capability table per language + an observable coverage report | analyzer |
| 3 | A half-built or schema-mismatched persisted graph can be served as if complete | **Index integrity attestation** — a deterministic post-build self-check that degrades loudly, never silently | architecture |
| 4 | A team re-indexes cold on every machine and in CI; no portable, conflict-free shared graph | **Shareable graph artifact** — schema-versioned, integrity-stamped, regenerate-don't-merge, bootstrap-or-rebuild | cli |
| 5 | The call graph stops at the process boundary; an HTTP client→server hop is dark | **Cross-service API topology** — client call-site → server route edges, within and across federated repos | analyzer |

## Reading order (dependencies)

| # | Change | Depends on (makes better, does not block) |
|---|--------|--------------------------------------------|
| 1 | `add-codebase-style-fingerprint` **(SHIPPED 2026-06-26 — `get_style_fingerprint` tool + `openlore style-fingerprint` CLI + `orient` `regionStyle`; descriptive idiom profile tallied in the call-graph walk; registry now derives the `styleFingerprint` capability; TS/JS/Python/Go)** | — |
| 2 | `add-declarative-language-support-registry` **(SHIPPED — PR #203; `get_language_support` tool + coverage matrix)** | — (foundation; widens 1 and 5 for free as languages land) |
| 3 | `add-index-integrity-attestation` | — |
| 4 | `add-shareable-graph-artifact` | 3 (the integrity stamp is what a consumer validates) |
| 5 | `add-cross-service-api-topology` | — (rides the IaC-projector pattern) |

## Design constraints inherited by every proposal in this set

- **Determinism is a hard constraint.** No learned, statistical, or predictive model. Where a peer
  system uses a learned policy (e.g. a bandit that picks a source-compression level from whether the
  agent re-read the file), we deliberately *do not* borrow the learned layer — only the deterministic
  structure underneath it, if any. Re-analysis of a fixed repository state is byte-identical.
- **Conclusion over graph** (`mcp-quality`). Any new tool returns the computed answer — a labeled
  fingerprint, a coverage table, an attestation verdict, a resolved cross-service edge set — never a
  node-and-edge dump for the agent to traverse by hand.
- **Honesty over coverage.** A signal below its evidence threshold returns `null` / "no signal," and
  an unresolvable reference emits no edge rather than a guessed one — consistent with the existing IaC
  extractors and the `confidence-boundary` / authoritative-recall invariants.
- **Tool-surface discipline.** New MCP tools default to opt-in. They land in a named preset, never in
  `MINIMAL_TOOLS` or the lean first-run default, so the first-run surface stays constant as the
  registry grows (`default-to-lean-tool-surface`, `mcp-quality`).
- **Additive, no schema break.** New fields are optional; stores and artifacts written before a
  change load without migration (the `AdditiveBitemporalMemorySchema` precedent).

## Out of scope for the whole set (explicitly considered, deliberately excluded)

- **Byte-level source compression modes** (signatures-only / strip-comments source windows). A peer
  system compresses returned source spans to save context budget. OpenLore has an existing, recorded
  preference for *reversible disclosure* — omitting whole items and reporting what was withheld —
  over lossy byte-shrinking (`add-trust-calibrated-context-economy`). We keep that stance; this set
  does not add a compression-mode ladder.
- **A learned token-budget policy** (e.g. re-read-penalty bandit). Excluded by the determinism
  constraint above.
- **Structural near-clone detection as a new capability.** OpenLore already computes clone groups
  internally (`src/core/analyzer/duplicate-detector.ts`; `CloneType` exact/structural/near,
  `CloneGroup`, `DuplicateDetectionResult`). The only gap is that this is not exposed as an agent-
  facing conclusion tool. That is a thin, separate follow-up ("expose near-clones of a symbol as a
  conclusion tool"), not a substrate gap, so it is noted here rather than specced as part of this set.
- **Co-change / behavioral coupling.** Already shipped (`get_change_coupling`).
- **Attempted-and-reverted intent surfacing.** Already shipped (`reversals.ts`, surfaced in `orient`
  and `recall`; `add-cross-agent-intent-handoff`).
- **Bi-temporal memory and "as-of" recall.** Already shipped (`add-bitemporal-typed-memory-operations`).

At implementation time, call `record_decision` before writing code for any proposal that introduces a
new tool, data structure, scoring rule, or on-disk format (per project `CLAUDE.md`).
