# Code-anchored agent memory with deterministic staleness

> Status: IMPLEMENTED — this is the foundational freshness engine the later memory proposals build on.
> Shipped: the anchor model (`StructuralAnchor` + `MemoryFreshness` `fresh|drifted|orphaned`,
> `src/types/index.ts`), deterministic anchor resolution + span hashing and the `anchorFreshness`
> engine (`src/core/decisions/anchor.ts`), memory↔code drift findings (`memory-drifted`/`memory-orphaned`
> in `src/core/drift/drift-detector.ts`), the opt-in `remember`/`recall` MCP tools
> (`src/core/services/mcp-handlers/memory.ts`, `memory` preset — never in `MINIMAL_TOOLS`), and the
> authoritative-recall invariant in both `orient` and `recall` (orphaned never served, drifted flagged
> `verify`). Tests: `anchor.test.ts`, `anchor-adversarial.test.ts`, `memory.test.ts`,
> `memory-invariant.test.ts`, `memory-staleness.test.ts`, `orient-memory-freshness.test.ts`. Spec delta
> merged into `openspec/specs/mcp-handlers/spec.md`.
> This is the change that makes the tagline true: **"Deterministic persistent memory for AI agents."**

## Why

OpenLore's tagline is now *deterministic persistent memory for AI agents*, and the goal is that
**anyone, using any AI agent (especially Claude Code), has bullet-proof context.** "Bullet-proof"
has a precise, testable meaning: a recalled memory is either *grounded in code that still exists as
remembered*, or it is *labeled as no longer trustworthy*. There is no third state where a stale
memory is served silently as fact. OpenLore does not meet that bar today.

### The gap, concretely

OpenLore already persists structure (call graph, signatures), specs, drift state, provenance, and a
memory substrate: the **decisions store**. But that substrate is not anchored to code in a way that
can self-invalidate:

- **A decision is anchored to file-path strings only.** `PendingDecision.affectedFiles: string[]`
  (`src/types/index.ts:406-445`) — no symbol references, no line spans, no content hash of the code
  it describes.
- **`orient` serves decisions as authoritative context regardless of whether that code still
  exists.** Pending and governing decisions are surfaced at `orient.ts:388-447` with no freshness
  check. A decision recorded against `validateDirectory` keeps getting served verbatim after that
  function is renamed, moved, or deleted.
- **Drift detection never checks memory.** `src/core/drift/drift-detector.ts` detects *spec ↔ code*
  drift (`gap`, `stale`, `orphaned-spec`, `adr-gap`, `adr-orphaned`) and `structural_diff`
  (`structural-diff.ts`) detects *stale callers* — but nothing detects *memory ↔ code* drift. A
  decision whose subject code has changed or vanished is never flagged.
- **There is no general agent-memory primitive at all.** The only durable, recallable memory is
  architectural decisions, gated behind the commit hook. An agent that learns "this retry loop must
  stay idempotent because the upstream queue is at-least-once" has nowhere deterministic to persist
  that and no guarantee it resurfaces — correctly or at all — the next time anyone touches that loop.

The result: as a codebase evolves, the memory OpenLore persists *decays into confident
misinformation*, and the agent has no way to know. That is strictly worse than no memory, and it is
the exact failure mode this change exists to make structurally impossible.

### Why OpenLore specifically can fix this

Probabilistic memory products (Mem0, Zep, Letta/MemGPT) store memories as embeddings in a vector
store. They can retrieve a relevant-looking memory, but they cannot *prove* whether the code that
memory describes still exists or still behaves as described — staleness is invisible to them by
construction. OpenLore has the one thing they don't: a **deterministic call graph extracted by
tree-sitter**, plus per-symbol source spans and content hashes it already computes. That makes
"is this memory still grounded?" a deterministic, local computation — symbol existence plus a
content-hash comparison — not an LLM guess. Code-anchored, self-invalidating memory is the
defensible thing OpenLore can own that a vector store cannot.

## What changes

1. **Structural anchor on every memory.** When a memory (a decision, or a general note — see #4) is
   recorded, OpenLore resolves the code it references to concrete call-graph nodes and stores a
   structural anchor per symbol: `{ nodeId, symbolName, filePath, contentHash }`. `contentHash`
   is the hash of the exact source span OpenLore already extracts for that node — no normalization,
   no new parsing. Resolution is deterministic (call-graph lookup), with no LLM.

2. **Deterministic freshness verdict at recall.** For each anchored memory, OpenLore computes one of
   three verdicts against the current graph, with **no tuning constant and no weighted score** —
   every input is a boolean:
   - **`fresh`** — the anchor's symbol still exists and its current `contentHash` equals the stored
     one. The memory is grounded.
   - **`drifted`** — the symbol still exists but its `contentHash` changed. The code the memory
     describes was modified; the memory may be partly stale and is flagged *verify before trusting*.
   - **`orphaned`** — the symbol no longer exists (renamed, moved, or deleted). The memory is
     unverifiable and MUST NOT be served as authoritative. When `structural_diff`'s existing rename
     detector (`structural-diff.ts`) confidently maps the old symbol to a new one, the verdict is
     reported as `drifted` with the relocation, reusing that machinery rather than adding a heuristic.

3. **Memory-staleness becomes a first-class drift class.** Extend the drift engine
   (`src/core/drift/drift-detector.ts`) with `memory-drifted` and `memory-orphaned`, so re-anchoring
   rides the same incremental update that already rebuilds the graph and recomputes drift. No new
   pass, no new schedule.

4. **A general `remember` / `recall` MCP pair, with decisions as one typed instance.** Today memory =
   architectural decisions only. Add a thin, general anchored-memory surface so any agent can persist
   and recall a durable, code-anchored fact, not just an architectural decision. A `decision` is
   simply a memory of `kind: "decision"` that also flows through the existing consolidation/sync
   pipeline; nothing about the decisions gate changes. Both tools are **conclusion-shaped**: `recall`
   returns the memory text plus its freshness verdict and anchor, never a graph to traverse.

5. **The bullet-proof guarantee, in `orient` and `recall`.** `orient` (`orient.ts:388-447`) and
   `recall` SHALL attach a freshness verdict to every memory they surface and SHALL NOT present an
   `orphaned` memory as authoritative context — it is either withheld from the authoritative section
   and listed separately as "needs re-anchoring," or shown with an explicit unverifiable label. This
   is the single requirement that earns the word "bullet-proof."

6. **Backfill for existing memory.** Legacy decisions carry only `affectedFiles` (no symbol anchor,
   no hash). They get **file-level** freshness (file exists? file content-hash changed since
   `recordedAt`?) — a coarser but still deterministic verdict — and an optional, deterministic
   upgrade that resolves symbols *named verbatim in the decision* to graph nodes when the names match
   exactly. No LLM is used to guess anchors; unupgradable decisions stay at file-level freshness.

## What does NOT change

- **No LLM anywhere in the anchor or freshness path.** Resolution and verdicts are static-analysis
  only — the north star (`overview/spec.md`, decision `c6d1ad07`) is preserved.
- **No new tuning constant, threshold, or composite score.** Freshness is `exists?` ∧ `hash equal?`,
  both boolean. This follows the same discipline as the navigation set's "labeled signals, not a
  blended salience score" (`openspec/changes/README.md`).
- **No new external dependency, service, or network call.** Content hashing and graph lookup use
  what OpenLore already computes locally.
- **The decisions schema is extended additively.** `anchors?: StructuralAnchor[]` is optional;
  existing `pending.json` stores load unchanged and fall back to file-level freshness.
- **The default and `minimal` tool surfaces stay constant in size.** `remember`/`recall` land in an
  opt-in `memory` preset (`TOOL_PRESETS`, `mcp.ts:1430`), never in `MINIMAL_TOOLS` or the first-run
  default — consistent with the `mcp-quality` "minimize tools an agent must consider" requirement.
- **The conclusion-over-graph contract is honored.** Both new tools classify as `conclusion` in
  `tool-contract.ts`; `tool-contract.test.ts` must pass.

## Research basis

This is the navigation set's principle (`openspec/changes/README.md`) applied to memory rather than
traversal: the **server computes the conclusion deterministically** (here, a freshness verdict) and
the agent consumes it — the agent never reasons about staleness itself, because in-model staleness
judgement degrades exactly the way in-model graph traversal does. It is fully consistent with the
north star: deterministic, locally computed, grounded in static analysis rather than LLM inference.

## Application to OpenLore

- **Anchor resolution** reuses the call graph and per-node source spans already produced by
  `signature-extractor.ts` / `call-graph.ts`; `contentHash` is a hash of the span OpenLore already
  extracts (the same span `get_function_body` returns).
- **Freshness** reuses `structural_diff`'s added/removed/renamed detection and signature comparison
  (`structural-diff.ts`) — `orphaned` vs `drifted` falls directly out of that diff.
- **Drift** extends the existing `DriftFinding` union and detector pass; no new orchestration.
- **Recall** reuses `orient`'s existing deterministic retrieval to *select* candidate memories; this
  change adds the *verdict*, not a new relevance model.

## Out of scope

- **Cross-repository memory and any cloud/team sync.** Memory stays local-first, per repo.
- **A relevance/ranking model for memories.** Which memories surface is still the existing
  deterministic retrieval; this change governs *trustworthiness*, not *selection*.
- **LLM-based memory dedup, summarization, or anchor-guessing.** Anchoring is exact-match only.
- **Migrating Claude Code's `MEMORY.md` file-memory into OpenLore.** Interop (OpenLore as a
  deterministic, code-anchored backing store that file-memory could write through) is a promising
  follow-up but is explicitly not built here; this change only makes OpenLore's own memory bulletproof.
- **Changing the decisions gate's install posture.** That is the separate `add-lean-default-tool-surface`
  proposal's concern.
