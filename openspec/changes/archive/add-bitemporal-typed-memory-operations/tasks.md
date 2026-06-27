# Tasks — Bitemporal validity and lifecycle operations for memory

> Ordered independently-shippable. Prefer extending existing tools (`recall` gains `asOf`, `remember`
> gains `supersedes`) over adding new tools, to keep the surface flat. Call `record_decision` before
> the schema change in step 1 and the contradiction-signal shape in step 4 (per `CLAUDE.md`).
> Depends on `harden-memory-integrity-invariant` for the invariant that suppresses invalidated memory.

## 1. Bitemporal fields (additive schema)
- [x] Add optional `validFromCommit` to the memory record, populated from `HEAD` at record time via
      the existing git access (`src/core/decisions/memory-store.ts`). Legacy memories load unchanged.
- [x] Add optional `invalidatedAt` + `invalidatedByCommit`, unset by default.
- [x] Test: a memory records the current `HEAD` SHA; reproducible for a fixed repo state.

## 2. Generalized supersede / invalidate
- [x] Extend `remember` to accept `supersedes: <memoryId>`; mark the prior memory invalidated
      (set `invalidatedAt` / `invalidatedByCommit`). Reuse the decision `supersedes` semantics.
- [x] Ensure invalidated memories never enter the authoritative set (delegated to change 1's
      invariant; add a test asserting it for the invalidated case specifically).

## 3. As-of recall
- [x] Extend `recall` with optional `asOf` (commit-ish); return memories authoritative as of that
      commit using the bitemporal fields. No new relevance model.
- [x] Test: a memory superseded at commit C is authoritative for `asOf` < C and absent for `asOf` >= C.

## 4. Contradiction surfacing
- [x] At recall/orient, detect two authoritative (`fresh`, non-invalidated) memories sharing a resolved
      anchor symbol (`nodeId` / `stableId`); emit an `unreconciled` conclusion-shaped signal. No LLM.
- [x] Test: two fresh memories on the same symbol surface as `unreconciled`; superseding one clears it.

## 5. Typed memory classification
- [x] Add optional `type` to the memory record from the closed set
      (`invariant` | `gotcha` | `rationale` | `convention` | `preference` | `todo` | `note`),
      defaulting to `note`. Caller-supplied only — no inference.
- [x] Extend `remember` to accept `type` and `recall` to accept an optional `type` filter.
- [x] Test: type stored as given; recall `type` filter restricts results; absent/unknown → `note`;
      legacy memories read as `note`.

## 6. `changedSince` recall
- [x] Extend `recall` with optional `changedSince` (commit-ish); return memories recorded or
      invalidated after that commit (most-recent first with no task; task relevance ranks first when
      given, recency as tiebreak). Exclusive boundary. Reuse bitemporal fields; no relevance model.
- [x] Test: M2 (after C1) returned, M1 (at/before C1) not, for `changedSince` = C1.

## 7. Content+anchor dedup and write hygiene
- [x] Change memory identity from `makeMemoryId(content, recordedAt)` (`memory.ts:65`) to a hash of
      content + resolved anchors, so identical (content, anchors) updates in place.
- [x] Retain and surface the unanchored warning on `remember`.
- [x] Test: re-recording identical (content, anchor) yields one record; same content on a different
      anchor yields two.

## 8. Surface discipline
- [x] Confirm no tool is added to `MINIMAL_TOOLS` or the default; new capability rides `recall` /
      `remember` params, or (if a `supersede` tool is added) only the opt-in `memory` preset.
- [x] Confirm `tool-contract.ts` classification holds (`conclusion`-shaped responses).

## 9. Docs
- [x] Document the bitemporal model, `asOf` / `changedSince` recall, typed classification, and
      content+anchor dedup in the `mcp-handlers` spec.
- [x] Note the additive schema fields (`validFromCommit`, `invalidated*`, `type`) in the
      `architecture` spec.
