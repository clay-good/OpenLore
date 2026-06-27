# Bitemporal validity, typed classification, and explicit lifecycle operations for memory

> Status: IMPLEMENTED (2026-06-18) — all 9 task sections shipped on branch
> `feat/bitemporal-typed-memory-operations`. Decision `48771c59` (ADR-0013). Spec deltas merged into
> `openspec/specs/mcp-handlers/spec.md` (BitemporalMemoryValidity, ExplicitMemorySupersession,
> DeterministicContradictionSurfacing, TypedMemoryClassification, ChangedSinceRecall, ContentAnchorDedup)
> and `openspec/specs/architecture/spec.md` (AdditiveBitemporalMemorySchema). 28 e2e tests
> (`bitemporal-memory.test.ts`) over a real git repo + an orient contradiction case; full suite green
> (3,923 passed); end-to-end dogfood confirmed against a real `analyze` run. See "Implementation
> status" at the foot of this file.
> Change 2 of the memory-integrity set (see `harden-memory-integrity-invariant`,
> `add-trust-calibrated-context-economy`). Depends on change 1's authoritative-recall invariant
> being the gate that suppresses invalidated memories.

## Why

A focused scan of the agent-memory field (Mem0, Zep/Graphiti, Letta/MemGPT, Cursor/Windsurf
memories) shows those products solving a problem OpenLore does not yet address — **how memory
*evolves* over time** — while OpenLore solves the one they cannot: **proving a memory is still
grounded in code.** Two of their primitives are worth borrowing in *shape*, kept fully deterministic.
The rest of their stack (LLM summarization, vector recall, auto-extraction) is exactly what the north
star excludes, and is rejected here explicitly.

### Gap 1 — OpenLore has only one point in time

Every memory records `recordedAt` (`memory-store.ts`) and decisions record `recordedAt` /
`consolidatedAt` / `syncedAt`. But there is no notion of the **code state a memory was valid against**
or of a memory being **superseded** by a later one. An agent cannot ask "what was the reasoning *as
of the commit where this decision was made*" versus "now." Zep/Graphiti's contribution is a
**bitemporal** model: a fact carries both *valid time* (the world-state it describes) and
*transaction time* (when the system learned it), and facts are *invalidated*, not blindly appended.
OpenLore already has the deterministic anchor for valid-time for free — the **commit SHA**. It is sitting
in git, never an LLM guess.

### Gap 2 — memory only grows; it never reconciles

`remember` appends. Nothing supersedes, invalidates, or reconciles. Two contradictory notes anchored
to the same function (e.g. "this cache is write-through" and a later "switched to write-back") can
both surface as authoritative, and the agent has no signal that they conflict. Mem0's contribution is
an explicit **memory lifecycle**: ADD / UPDATE / DELETE / NOOP with conflict resolution. Letta's is
**self-editing memory blocks**. OpenLore already has half of this for decisions — `record_decision`
accepts `supersedes` (`CLAUDE.md`, the 8-char prior-ID mechanism). This change generalizes that one
proven primitive to all memory and makes contradiction *visible* rather than silently double-served.

### Gap 3 — memory is flat and untyped

A memory is one of two `kind`s (`note` | `decision`, `memory.ts:96`) and otherwise free text. The
agent-memory field consistently finds that **typed** memory recalls better: separating a standing
invariant from a one-off gotcha from a rationale lets recall filter to the kind the task needs and
lets the agent reason about what each item *is*. OpenLore already names this vocabulary informally —
the `remember` tool description says "an invariant, gotcha, or rationale" (`mcp.ts:1513-1514`) — but
the type is not captured, stored, or filterable. The deliberate non-borrow: the field assigns types
with an LLM classifier; OpenLore takes the type as an **explicit caller field** from a small closed
set, defaulting to `note`. No inference.

### Gap 4 — `remember` accumulates near-duplicates and offers no write hygiene

`remember` keys each memory by `makeMemoryId(content, recordedAt)` (`memory.ts:65`), so the *same*
fact recorded twice at different times produces two records that both surface. The field's "no silent
overwrite" principle has a quieter companion: don't silently *duplicate* either, and don't store what
is already in the code. OpenLore can enforce a deterministic slice of this — content-identical dedup
and an unanchored/derivable warning — without any LLM judgement of "importance."

## What changes

1. **Bitemporal stamping, deterministically.** Every memory gains `validFromCommit` (the `HEAD` SHA
   at record time, read from git — deterministic, no LLM) alongside the existing `recordedAt`
   (transaction time). On supersession a memory gains `invalidatedAt` and `invalidatedByCommit`. This
   is two-axis time: *what code state the memory was true for* and *when OpenLore recorded/retired it.*

2. **As-of recall.** `recall` accepts an optional `asOf` (a commit-ish). With it, recall returns the
   memories that were authoritative *as of that commit* — what the agent would have known then. This
   reuses the bitemporal fields; it adds no relevance model.

3. **Generalized supersede / invalidate.** Extend the decisions-only `supersedes` mechanism to all
   memory: a `remember` (or a dedicated `supersede`) call may declare `supersedes: <memoryId>`,
   marking the prior memory invalidated. An invalidated memory is **never** served as authoritative
   (enforced by change 1's invariant), but remains queryable via `asOf` for history. Deterministic:
   supersession is an explicit caller act, not an inferred merge.

4. **Deterministic contradiction surfacing.** When two *authoritative* (`fresh`, non-invalidated)
   memories anchor to the **same symbol**, `recall` and `orient` SHALL flag the pair as `unreconciled`
   — a conclusion-shaped signal ("these two grounded memories describe the same symbol; reconcile or
   supersede one") — rather than silently serving both as independent fact. No LLM decides which wins;
   the agent is told a contradiction exists and acts.

5. **Typed memory, deterministically.** `remember` accepts an optional `type` from a small closed set
   — `invariant`, `gotcha`, `rationale`, `convention`, `preference`, `todo`, `note` (default) —
   formalizing the vocabulary already in the tool description. `recall` accepts an optional `type`
   filter. The type is a caller-supplied label, never an LLM classification; an absent type defaults
   to `note`, so legacy memories and unlabeled writes behave exactly as today.

6. **`changedSince` recall — the differential companion to `asOf`.** `recall` accepts an optional
   `changedSince` (a commit-ish): it returns the memories recorded or invalidated *after* that commit,
   so an agent resuming work can ask "what intent about this code changed since I last saw it?" This
   reuses the same bitemporal fields as `asOf`; it adds no relevance model and no new storage.

7. **Content-identical dedup and write hygiene.** `remember` SHALL key dedup on a hash of *content
   plus resolved anchors* (not content plus timestamp), so re-recording the same fact about the same
   code updates in place instead of accumulating a second record. The existing unanchored warning is
   retained and extended: `remember` SHALL surface when a memory is unanchored (cannot self-invalidate)
   so the caller can choose to anchor it. No LLM judges importance; dedup is an exact hash equality and
   the warning is a structural fact.

## What does NOT change

- **No LLM, no vector store, no auto-extraction.** We borrow the *shape* (temporal validity,
  lifecycle ops, contradiction signal), never the non-deterministic mechanism. `validFromCommit` is
  read from git; supersession is an explicit caller act; contradiction is "same anchor symbol," a
  set comparison. North star (`overview/spec.md`, decision `c6d1ad07`) preserved.
- **No new tuning constant or score.** "Same symbol," "before/after a commit," and "invalidated?" are
  all exact predicates.
- **Schema is extended additively.** `validFromCommit`, `invalidatedAt`, `invalidatedByCommit`, and
  the optional `type` are all optional; legacy memories load unchanged and behave as today
  (always-valid, never-invalidated, `type` defaulting to `note`).
- **Typing is a closed caller field, never inferred.** The seven-value set is fixed and documented; an
  unknown or absent value resolves to `note`. No LLM, no auto-classification, no per-type heuristic.
- **Dedup is exact, not semantic.** It keys on a content+anchor hash equality; it never merges
  "similar" memories or judges which of two distinct facts matters more.
- **The decisions gate and sync pipeline are untouched.** A decision remains a memory of
  `kind: "decision"`; its `supersedes` already works — this change extends the same field to notes.
- **The default and `minimal` tool surfaces stay constant.** Any new tool (e.g. `supersede`, or an
  `asOf` parameter on `recall`) lands only in the opt-in `memory` preset, never in `MINIMAL_TOOLS` or
  the first-run default — per the `mcp-quality` minimize-surface rule. Preference: extend `recall`
  with `asOf` and `remember` with `supersedes` rather than add tools at all.

## Research basis

- **Zep / Graphiti** (bi-temporal knowledge graph for agent memory): valid-time vs. transaction-time,
  and explicit fact invalidation over time rather than unbounded append.
- **Mem0** (memory lifecycle: ADD/UPDATE/DELETE/NOOP with conflict resolution) and **Letta/MemGPT**
  (self-editing memory blocks): memory must reconcile, not only accumulate.

The deliberate non-borrow — the part the north star forbids — is *how* those systems decide validity
and conflict: an LLM. OpenLore substitutes deterministic substrates it already owns: the git commit
graph for time, the call graph for "same symbol," and an explicit caller act for supersession.

## Application to OpenLore

- `validFromCommit` reuses the git access OpenLore already has for change-coupling and structural
  diff; no new git surface.
- Supersession reuses the existing `supersedes` field and the decision store's lifecycle, generalized
  to the memory store (`memory-store.ts`).
- Contradiction surfacing reuses the structural anchors from `add-code-anchored-memory-staleness`:
  two memories with the same resolved `nodeId` / `stableId` and both `fresh` are the `unreconciled`
  pair. It is a set intersection over anchors, computed at recall.

## Out of scope

- **Tiered / budgeted recall** (core vs. recall-on-demand) — that is the token concern of
  `add-trust-calibrated-context-economy`.
- **Automatic contradiction *resolution*.** This change *surfaces* contradiction; choosing the winner
  stays with the agent or an explicit supersede call. No LLM merge.
- **Cross-repository or team-shared temporal memory.** Memory stays local-first, per repo.
- **A structural query language over the call graph** (CodeQL/Joern-style). Noted as a promising
  future swing; not built here.

## Implementation status

Shipped 2026-06-18 on branch `feat/bitemporal-typed-memory-operations`. All nine task sections
complete; every change additive and deterministic (no LLM, no tuning constant), so legacy stores load
unchanged.

- **§1 Bitemporal fields** — `AnchoredMemory` gains optional `validFromCommit` (HEAD SHA at record
  time), `invalidatedAt`, `invalidatedByCommit`, `supersedes` (`src/types/index.ts`). `remember`
  stamps `validFromCommit` from `getHeadCommit` (`src/core/decisions/git-time.ts`).
- **§2 Generalized supersede / invalidate** — `remember` accepts `supersedes: <id>`; the prior memory
  is marked invalidated inside the CAS mutate and leaves the authoritative set (the change-1
  invariant) but stays queryable via `asOf`.
- **§3 As-of recall** — `recall` accepts `asOf` (commit-ish); valid-time is compared by git ancestry
  (`merge-base --is-ancestor`), not wall-clock, so history is reproducible for a fixed repo state.
- **§4 Contradiction surfacing** — `findUnreconciled` (`src/core/decisions/anchor.ts`) is a pure set
  intersection over symbol-level anchors; surfaced as `unreconciled` in `recall` and
  `unreconciledMemories` in `orient`.
- **§5 Typed classification** — closed `MemoryType` set; `remember` `type` (default `note`, never
  inferred), `recall` `type` filter.
- **§6 `changedSince` recall** — differential companion to `asOf`; returns memory recorded or
  invalidated after a commit.
- **§7 Content+anchor dedup** — `makeMemoryId(content, anchors)` keys identity on content + resolved
  anchors, so re-recording the same fact updates in place; the unanchored warning is retained.
- **§8 Surface discipline** — no new tool; the capability rides `recall`/`remember` params. Default
  and `minimal` surfaces unchanged; the full tools/list budget was bumped 55k→57k as a documented,
  conscious decision (descriptions trimmed first).
- **§9 Docs** — bitemporal model, `asOf`/`changedSince`, typed classification, and content+anchor
  dedup documented in the `mcp-handlers` spec; additive schema fields documented in the
  `architecture` spec. Decision `48771c59` (ADR-0013).

**Verification:** `bitemporal-memory.test.ts` (28 e2e cases over a real git repo: validFromCommit
reproducibility, supersede→asOf history, asOf/changedSince boundary cases, self-supersede guard,
already-invalidated supersede, unreconciled + clear, type-filter-scoped contradiction surfacing,
invalidated-without-commit fail-closed under asOf, file-level-anchor guard, typed filter, legacy
records under temporal filters, invalid-filter graceful degradation, dedup) plus an orient
contradiction case in `orient-memory-freshness.test.ts`. Full suite green (3,923 passed, 2
skipped); lint clean; typecheck clean. End-to-end dogfood (see `DOGFOOD-bitemporal.md`) drove the
built handlers against a real `openlore analyze` run and confirmed every behavior.
