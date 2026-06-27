# Tasks — Code-anchored agent memory with deterministic staleness

> Ordered so each step is independently shippable and additive until the recall guarantee lands.
> Per project `CLAUDE.md`, call `record_decision` before writing code for the data-model and the
> two new tools (new data structure + API contract).
>
> **Implementation status (PR #141, `feat/code-anchored-memory-staleness`):** ALL sections (1–8)
> are implemented and tested.
> - §1–3, 5, 7, 8: anchor model + pure engine, deterministic resolution, fresh/drifted/orphaned
>   freshness, the `remember`/`recall` tools in an opt-in `memory` preset with the bullet-proof
>   guarantee, and legacy file-level freshness.
> - §4: `memory-drifted`/`memory-orphaned` are now first-class `check_spec_drift` findings
>   (`detectMemoryStaleness` in `drift-detector.ts`, folded into `detectDrift` issues + summary).
> - §6: `orient` attaches a freshness verdict to every surfaced decision and segregates `orphaned`
>   ones into `staleDecisions`, never the authoritative `pendingDecisions` — the guarantee now holds
>   at the default entry tool, proven end-to-end in `orient-memory-freshness.test.ts`.
>
> Test coverage: pure engine (`anchor.test.ts`), disk adapter incl. byte-accurate multibyte spans +
> clamping (`anchor-adapter.test.ts`), `record_decision` anchoring (`decisions-anchoring.test.ts`),
> `remember`/`recall` incl. adversarial inputs (`memory.test.ts`), drift staleness
> (`memory-staleness.test.ts`), and the orient guarantee (`orient-memory-freshness.test.ts`).

## 1. Anchor data model (additive, non-breaking)
- [ ] Add `StructuralAnchor { nodeId, symbolName, filePath, contentHash }` and `MemoryFreshness`
      (`'fresh' | 'drifted' | 'orphaned'`) to `src/types/index.ts` near the decision types (~`:406`).
- [ ] Extend `PendingDecision` with optional `anchors?: StructuralAnchor[]` and `kind?: 'decision' | 'note'`.
      Existing `pending.json` stores load unchanged (anchors absent ⇒ file-level freshness).
- [ ] Define `contentHash` as a hash of the exact node source span already extracted by
      `signature-extractor.ts` — document that it is unnormalized and reproducible.

## 2. Deterministic anchor resolution (no LLM)
- [ ] On record, resolve each referenced symbol to a call-graph node id and capture its `contentHash`
      (`src/core/decisions/` + `call-graph.ts`). Symbols come from explicit `anchors` input or from
      `affectedFiles` (file-level only) when none are named.
- [ ] Exact-match only: a symbol that does not resolve to a graph node is recorded as a file-level
      anchor, never guessed. Log the unresolved name; do not fail the write.
- [ ] Test: recording a memory against a known function captures `{ nodeId, contentHash }`; recording
      against an unknown name falls back to file-level with no error.

## 3. Freshness computation (booleans only, no threshold)
- [ ] Compute `fresh | drifted | orphaned` per anchor against the current graph: symbol-exists ∧
      hash-equal. No weighted score, no tunable cutoff.
- [ ] When the symbol is absent, consult `structural_diff`'s rename map (`structural-diff.ts`); a
      confident rename downgrades `orphaned` → `drifted` with the new location. No new heuristic.
- [ ] A memory's overall verdict is the worst of its anchors' verdicts (orphaned > drifted > fresh).
- [ ] Test: body edit ⇒ `drifted`; rename/delete ⇒ `orphaned`; confident rename ⇒ `drifted` + new loc;
      untouched ⇒ `fresh`. (Lives in a plain `.test.ts` so CI runs it.)

## 4. Memory-staleness as a drift class
- [ ] Add `memory-drifted` and `memory-orphaned` to the `DriftFinding` union and detect them in
      `src/core/drift/drift-detector.ts`, reusing the same incremental graph rebuild.
- [ ] `check_spec_drift` output includes memory-staleness findings (or document a sibling field).
- [ ] Test: a decision anchored to a function that is then deleted surfaces as `memory-orphaned`.

## 5. `remember` / `recall` MCP tools (opt-in `memory` preset)
- [ ] `remember(content, anchors?, kind?)` — persists an anchored memory (kind `note` by default;
      `decision` flows through the existing consolidation/sync pipeline unchanged).
- [ ] `recall(task)` — returns relevant memories (existing deterministic retrieval) each with its
      freshness verdict and anchor. Conclusion-shaped: text + verdict + anchor, never a graph.
- [ ] Register both in a new `memory` entry in `TOOL_PRESETS` (`mcp.ts:1430`); add neither to
      `MINIMAL_TOOLS` nor the first-run default.
- [ ] Classify both as `conclusion` in `tool-contract.ts`; confirm `tool-contract.test.ts` passes.

## 6. The bullet-proof guarantee in `orient` + `recall`
- [ ] Attach a freshness verdict to every memory surfaced in `orient` (`orient.ts:388-447`).
- [ ] Never place an `orphaned` memory in the authoritative context section — withhold it to a
      separate "needs re-anchoring" list or label it explicitly unverifiable.
- [ ] `drifted` memories carry a `verify` flag.
- [ ] Test: an orphaned memory never appears unlabeled in `orient`/`recall` authoritative output.

## 7. Backfill for legacy decisions
- [ ] Legacy decisions (anchors absent) get file-level freshness: file-exists ∧ file-hash-unchanged
      since `recordedAt`.
- [ ] Optional deterministic upgrade: resolve symbols named verbatim in `title`/`rationale` that
      exactly match a graph node; otherwise stay file-level. No LLM.
- [ ] Test: a legacy decision whose file was deleted reports file-level `orphaned`.

## 8. Docs
- [ ] Update `CODEBASE.md` MCP workflow + `CLAUDE.md` tool table with `remember`/`recall` and the
      `memory` preset, noting they are opt-in.
- [ ] One paragraph in the relevant spec(s): recalled memory always carries a freshness verdict; an
      orphaned memory is never served as authoritative. Cite the bullet-proof guarantee requirement.
