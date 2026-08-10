# OpenLore — Generation & Repair, High-Level Spec (Working Draft)

Status: draft / working base — not final
Scope: architecture for spec *generation* and spec *repair*, and the boundary with OpenSpec

## 1. Goals

- Let OpenLore produce OpenSpec-compatible specs from an existing codebase, in two contexts:
  1. **Standalone** (CLI/CI, legacy pipelines) — no host agent present.
  2. **Agent-hosted** (Claude Code or any MCP-capable agent) — OpenLore runs inside an
     agent session and lets the host agent do the writing.
- Add a second capability: **repair** an existing OpenSpec spec base that is
  incomplete or has diverged from the current codebase, using the same underlying
  pipeline as generation.
- Keep a single shared core so both facades and both capabilities (generate, repair)
  reuse the same analysis/graph/retrieval logic — only the output and the writer differ.

## 2. Non-goals

- OpenLore does not decide *what the user wants to build* and does not manage
  propose → apply change workflows. That remains OpenSpec's job.
- OpenLore does not become a general spec-driven-development framework.
- Repair means reconciling specs with what the code *currently is*, not proposing
  new functionality. Anything that looks like "add capability X" belongs to OpenSpec,
  not to OpenLore's repair mode.

## 3. Architecture overview

```
                    ┌─────────────────────────────┐
                    │           Core               │
                    │  1. codebase analysis         │
                    │  2. knowledge graph           │
                    │  3. retrieval                 │
                    │  4. context construction       │
                    │  5. drift / gap detection      │
                    │     (generate vs repair)       │
                    └───────────────┬───────────────┘
                                    │
                    structured context / diff (facade-agnostic)
                                    │
                 ┌──────────────────┴──────────────────┐
                 │                                       │
        Standalone facade                        Agent facade (MCP)
        (owns its own LLM call)                  (returns context, host agent writes)
                 │                                       │
                 ▼                                       ▼
          writes/patches OpenSpec files         host agent writes/patches OpenSpec files
```

The core never knows which facade is calling it, and never knows whether the
call is a *generate* or a *repair* — that only affects which detection step (5)
runs and what gets fed into the context payload.

## 4. Capability: Generate

Unchanged from current behavior, reframed as one of two entry points into the core:

1. Analyze codebase → build/update knowledge graph.
2. Retrieve relevant elements for the target scope (module, feature, whole repo).
3. Construct structured context.
4. Hand off:
   - Standalone: OpenLore's own LLM provider drafts the spec text and writes it.
   - Agent facade: `prepare_spec_context()` returns the structured context; the
     host agent drafts the spec text and writes it.

## 5. Capability: Repair

New capability. Input: an existing OpenSpec spec base (possibly partial, possibly stale)
plus the current codebase.

### 5.1 Drift detection (core, facade-agnostic)

Classify each existing spec (or expected-but-missing spec) into:

- **Missing** — code element exists, no corresponding spec.
- **Stale** — spec exists, but analysis shows the described behavior/structure no
  longer matches the code (signature changes, removed/renamed components, changed
  relationships in the graph).
- **Orphaned** — spec exists, no corresponding code element found anymore.
- **Consistent** — spec still matches; not touched.

Output of this step: a structured drift report (per spec: classification + the
specific evidence — e.g. which graph nodes/edges changed).

### 5.2 Repair output, per facade

- **Standalone**: for each Missing/Stale item, OpenLore's LLM provider drafts a
  patch (new spec or updated section) and applies it directly; Orphaned items are
  flagged for removal (not auto-deleted, to avoid destructive surprises).
- **Agent facade**: `repair_context()` (or similar) returns the drift report plus
  the structured context needed to fix each item; the host agent proposes/applies
  the patches, subject to its own review/permission flow.

### 5.3 Explicit boundary

Repair only reconciles specs with what the code *is*. It never infers or proposes
new intended behavior. If drift detection can't determine a confident classification
(e.g. ambiguous rename vs. new component), it should surface that as a question/flag
rather than guess — consistent with OpenLore's existing confidence-boundary work.

## 6. Interfaces (draft)

Standalone (existing, extended):
```
openlore generate-spec [--scope <path>]
openlore repair-spec [--scope <path>] [--dry-run]
```

Agent facade (MCP tool surface, draft names):
```
openlore.analyze()
openlore.search()
openlore.get_context()
openlore.get_minimal_context()
openlore.prepare_spec_context()      # generate
openlore.detect_drift()              # repair, step 5.1 only
openlore.repair_context()            # repair, steps 1-5.1 + context for fixing
```

## 7. Open questions

- Does the generation prompt differ between standalone and agent facade, or is it
  shared? — **undecided**, to be settled empirically once the MCP facade has real
  usage to compare against.
- Repair dry-run vs. auto-apply default, for both facades — needs a decision before
  implementation, given Orphaned-item deletion is destructive by nature.
- Should `detect_drift()` be exposed as its own MCP tool independent of repair
  (e.g. for a host agent that just wants a drift report without fixing anything)?
