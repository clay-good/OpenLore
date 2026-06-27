# Tasks — Task-scoped context injection

> Status: IMPLEMENTED (2026-06-22). All tasks complete. Decisions recorded before code: `27c4bb53` (inject shape + budget), `0fc964d3` (relevance gate), `1d35a27b` (UserPromptSubmit wiring). No new MCP tool — gate `tool-contract.ts` is unaffected.

## 1. `orient --inject` CLI mode
- [x] Add an `--inject` flag to `openlore orient` (`src/cli/commands/orient.ts`) that reads the task
      from `--task` or, when absent, from the hook stdin payload (the harness passes the user prompt
      on stdin), and emits an injection-shaped block to stdout.
- [x] The block reuses `orient --lean` (Spec 27) output, is capped by a documented token budget
      (default ~600 tokens, configurable), is clearly attributed to OpenLore, and opens with a
      one-line "informational; you may ignore this" framing (Epistemic Lease posture, decision
      `8e95746d`). On stdin with an empty/whitespace prompt it degrades to the single pointer line.
- [x] Errors never propagate to the harness: a missing graph, parse failure, or empty match emits the
      pointer-line fallback and exits 0 (a hook must never break the user's turn).
- [x] Test: `--inject --task "<x>"` on an analyzed repo emits a budgeted, attributed, ignorable block;
      `--inject` with no graph emits the pointer line and exits 0; output never exceeds the budget.

## 2. Deterministic orientation-relevance gate
- [x] Compute a local, no-LLM relevance signal from the orient result + EdgeStore (matched-function
      count, max fan-in / hub centrality of matches, and the top match score on the bounded
      semantic/hybrid scale). Define the
      documented threshold below which orientation is judged unlikely to pay (the small/familiar/
      shallow arena the scorecard says OpenLore should not tax).
      → reuse fields already on the orient result; no new analysis pass.
- [x] When the signal is below threshold, `--inject` emits the single pointer line instead of the full
      block. The threshold and its inputs are documented (and overridable in `.openlore/config.json`),
      never learned.
- [x] Test: a sparse-graph / weak-match task gates down to the pointer line; a strong-match deep task
      emits the full block; the threshold boundary is covered by a deterministic fixture.

## 3. `UserPromptSubmit` install wiring (claude-code adapter)
- [x] In `src/cli/install/adapters/claude-code.ts`, add a marker-identified (`_openlore: true`)
      `UserPromptSubmit` hook group that runs `npx --yes openlore orient --inject`, mirroring the
      existing `SessionStart` group (`isOurHookEntry` / `mergeOurHook` / `stripOurHook`
      generalized over both hook keys). Re-running install replaces only our marker-identified group
      (a stale OpenLore group self-heals; never duplicated); user-authored sibling hooks and the
      file's format are preserved byte-for-byte.
- [x] `--uninstall` strips the `UserPromptSubmit` group exactly as it strips `SessionStart`, deleting
      now-empty parents and the file if it was OpenLore-only.
- [x] `--dry-run` previews the added group.
- [x] Test: apply adds both `SessionStart` and `UserPromptSubmit` OpenLore groups idempotently;
      uninstall removes both and leaves any user-authored hooks byte-identical; a stale OpenLore group
      is replaced in place (self-heal), not duplicated. (The marker-identified hook group is not
      fingerprint-protected — hand-edit refusal applies only to the `CLAUDE.md` block and `.mcp.json`.)

## 4. Per-adapter coverage + graceful fallback
- [x] For each non-Claude adapter (`cursor.ts`, `cline.ts`, `continue.ts`, `agents-md.ts`), wire the
      equivalent first-prompt mechanism where one exists; where none exists, leave the existing
      instruction block as the fallback and record that the adapter has no pre-turn injection channel.
- [x] Document per-adapter injection support in `docs/install.md` (a small support matrix).
- [x] Test: each adapter either wires task-scoped injection or cleanly falls back without error;
      `--dry-run` and `--uninstall` are coherent for every adapter.

## 5. Opt-out + bounding config
- [x] Add a `.openlore/config.json` switch (e.g. `contextInjection: { mode: "off" | "task-scoped" }`,
      default `task-scoped`) read by `orient --inject`; when `off`, `--inject` emits nothing (exit 0)
      and install still wires SessionStart + MCP as today.
      → `src/core/services/config-manager.ts`, `src/types/index.ts`.
- [x] Honor the token budget from config; never exceed it regardless of match size.
- [x] Test: `mode:"off"` makes `--inject` a no-op; a custom budget caps the block; defaults are
      `task-scoped` + ~600 tokens.

## 6. Docs
- [x] Document task-scoped injection (what it injects, the relevance gate, the opt-out, the token
      budget, the facts-not-coercion posture) in `docs/install.md` and the `cli` + `mcp-handlers`
      specs. Cross-link the Value Scorecard so the reader sees which loss case this closes.
- [x] Update the README quickstart to note that, after `openlore install`, each task begins already
      oriented (no manual `orient` call needed for the common case).
