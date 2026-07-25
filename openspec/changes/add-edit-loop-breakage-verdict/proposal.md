# The graph learns about a breaking edit in milliseconds; the agent learns at commit time

> Status: PROPOSED (2026-07-23, competitive substrate sweep). Deterministic per-edit
> verification is the single best-evidenced lever for agent success in the current literature —
> error-guided feedback loops raise correctness 21–32 pts (https://arxiv.org/html/2504.06939v2),
> and telling the agent *which tests to check per edit* drives self-correction
> (https://arxiv.org/pdf/2603.17973). OpenLore's watcher already re-extracts an edited file and
> patches the graph within one debounce — and then says nothing. The pre/post facts needed to
> conclude "this edit broke caller X at line N" are in hand at patch time and are discarded.
> Sibling boundary: `add-agent-loop-enforcement-hook` delivers GOVERNANCE findings into the
> agent loop; this change computes new STRUCTURAL breakage findings at edit time and reuses the
> same delivery discipline. `structural_diff` remains the git-ref, review-time sibling.

## The gap

- **The watcher compares old vs new symbols only to route re-resolution.** `handleBatch`
  captures `oldNames` (`src/core/services/mcp-watcher.ts:556`) and uses the delta solely to
  decide which other files to re-resolve (`:582-617`); it patches the graph and emits one
  summary line (`:753-754`). No verdict of any kind is derived.
- **A deleted/renamed symbol with live call sites is not a finding anywhere.** Surviving call
  sites silently degrade to `external::`/ambiguous edges; `structural_diff` computes stale
  callers only when explicitly invoked against git refs, re-parsing snapshots per call
  (`structural-diff.ts:221-224`, stale callers `:333-344`).
- **Arity is modeled but never checked.** The SCIP moniker builder computes arity with an
  explicit "TODO: arity in analyzer" (`src/core/scip/moniker.ts:154-156`); federation marks
  call-site arity "unconfirmed" (`fleet-memory.ts:16,159`; `resolver.ts:180`). No code compares
  a call site's argument count to its callee's parameters.
- **The loop has no delivery vehicle.** Hooks today are git pre-commit only
  (`setup.ts:629-633`); the legacy PostToolUse hook was deliberately uninstalled because it ran
  a full analyze in the hook (`setup.ts:631-633`) — the right lesson is "no analysis inside the
  hook", not "no hook": the watcher already does the analysis; the hook only needs to read the
  verdict.

## What changes

1. **Call sites gain an argument count at extraction.** `RawEdge`/`CallEdge` carry `argCount`
   (captured at the call node — the extractor is already there), alongside the existing `line`.
   One integer per edge; enables the arity check and strengthens the SCIP export.
2. **A per-edit verdict, derived at watcher patch time from data already in hand:**
   - `edit-broken-reference` — a symbol removed/renamed by this edit still has resolved call
     sites in other files (each named `file:line` from the stored edge lines);
   - `edit-arity-mismatch` — a signature change (or a pre-existing call to this file's symbols)
     where the call site is PROVABLY incompatible: fewer args than required params, or more
     args than total params with no variadic/spread/default in play. Anything short of provable
     is silent — never a guess. Scope: TS/JS/Python signatures (disclosed; other languages
     fail-soft to no arity finding);
   - `edit-import-breakage` — an import of a name the edited file no longer exports;
   - plus the reaching tests for the edited symbols (the existing `select_tests` reachability,
     scoped to the edit) so the verdict says what to run, not just what broke.
   The verdict persists beside the artifacts with the edit's content hash; computing it is
   O(edited symbols' callers) — bounded by the same closure the watcher already re-resolves.
3. **Delivery: read, never compute, in the loop.** `openlore check-edit [--json] [--hook]`
   returns the latest verdict for the file (or the working set) in one read. Hook mode follows
   the impact-certificate discipline verbatim: infrastructure failure or absent daemon never
   blocks (`impact-certificate.ts:162-181` precedent), human rendering to stderr, blocking
   opt-in only via `enforcement.policy` on the new codes. With no daemon running, `check-edit`
   computes a one-file scoped diff directly (the `structural_diff` machinery bounded to one
   file), disclosed as the slower path.
4. **The finding codes are governed like all others:** `edit-broken-reference`,
   `edit-arity-mismatch`, `edit-import-breakage` register in `FINDING_CODE_REGISTRY` with
   source-declared severities, advisory by default, emitted in the unified `GovernanceFinding`
   shape — so `openlore enforce`, the review action, and the loop hook all speak them without
   new plumbing.

**Deliberately NOT borrowed** from the verification-loop literature: no typechecker or compiler
invocation (that is the opt-in LSP evidence tier's territory, `add-lsp-evidence-tier`), no test
execution (OpenLore never runs tests), no LLM judgment of severity. The verdict is the sound,
provable subset — reference existence, arity bounds, export presence — computed from facts the
graph already holds, with everything unprovable staying silent.

## Why this is in scope

This closes the substrate's loop-latency gap: OpenLore currently knows about breakage before
any other tool on the machine and tells the agent last (at commit). Turning patch-time knowledge
into a sub-second conclusion is the "deterministic checker inside the agent's turn" pattern the
evidence ranks first, built entirely from shipped machinery — watcher, edge lines, select_tests,
finding registry, hook discipline.

## Impact

- Files: `src/core/analyzer/call-graph.ts` + `call-graph-types.ts` (argCount on edges),
  `src/core/services/mcp-watcher.ts` (verdict derivation at patch), a small verdict store
  beside the artifacts, new `src/cli/commands/check-edit.ts` (read + hook modes),
  `enforcement-policy.ts` (3 new codes), `setup.ts` (opt-in PostToolUse-shaped hook install).
- Specs: `analyzer` — 1 ADDED (CallSitesCarryArgumentCounts); `mcp-handlers` — 2 ADDED
  (EditVerdictIsDerivedAtPatchTime, EditVerdictNeverGuessesIncompatibility).
- One new CLI command; no new MCP tool (the verdict is CLI/hook-delivered; an MCP surface, if
  ever wanted, is a follow-up with its own conclusion classification). Risk: medium — false
  positives would train agents to ignore the verdict; the provable-only rule, per-language
  scoping, and advisory default are the mitigations, and the arity rule's honesty is pinned by
  fixtures (defaults, variadics, spreads, overloads → silent).
