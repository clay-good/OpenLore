# The graph learns about a breaking edit in milliseconds; the agent learns at commit time

> Status: BUILT (2026-08-23). Deterministic per-edit
> verification is the single best-evidenced lever for agent success in the current literature —
> error-guided feedback loops raise correctness 21–32 pts (https://arxiv.org/html/2504.06939v2),
> and telling the agent *which tests to check per edit* drives self-correction
> (https://arxiv.org/pdf/2603.17973). OpenLore's watcher already re-extracts an edited file and
> patches the graph within one debounce — and then says nothing. The pre/post facts needed to
> conclude "this edit broke caller X at line N" are in hand at patch time and are discarded.
> Sibling boundary: `add-agent-loop-enforcement-hook` delivers GOVERNANCE findings into the
> agent loop; this change computes new STRUCTURAL breakage findings at edit time and reuses the
> same delivery discipline. `structural_diff` remains the git-ref, review-time sibling.

## Why

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

## What Changes

1. **Call sites gain an argument count at extraction.** `RawEdge`/`CallEdge` carry `argCount`
   (captured at the call node — the extractor is already there), alongside the existing `line`.
   One integer per edge; enables the arity check and strengthens the SCIP export.
2. **A per-edit verdict, derived at watcher patch time from data already in hand:**
   - `edit-broken-reference` — a symbol removed/renamed by this edit still has resolved call
     sites in other files (each named `file:line` from the stored edge lines);
   - `edit-arity-mismatch` — a signature change (or a pre-existing call to this file's symbols)
     where the call site is PROVABLY incompatible: fewer args than required params, or more
     args than total params with no variadic/spread/default in play. Anything short of provable
     is silent — never a guess. Scope: TypeScript and Python signatures. JavaScript call sites
     retain argument counts, but JavaScript's runtime arity rules are not treated as proof;
   - `edit-import-breakage` — an import of a name the edited file no longer exports;
   - plus exact-ID reaching tests from the retained full-analysis graph, scoped to the edit, so
     the verdict says what to run without adding test nodes to the production EdgeStore.
   The verdict persists beside the artifacts with generation, content, and fact-basis hashes.
   Reads, reachability, findings, and artifact size are bounded and fail open when freshness
   cannot be proved.
3. **Delivery: read, never compute, in the loop.** `openlore check-edit [--json] [--hook]`
   returns the latest current verdict for the file (or the working set) without analysis. Hook
   mode follows the impact-certificate discipline: infrastructure failure or absent daemon never
   blocks (`impact-certificate.ts:162-181` precedent), human rendering to stderr, blocking
   opt-in only via `enforcement.policy` on the new codes. Missing, stale, malformed, or
   unavailable watcher state is disclosed and fails open; `structural_diff` is not used as an
   approximate fallback because it cannot reproduce the same call-arity and import facts.
4. **The finding codes are governed like all others:** `edit-broken-reference`,
   `edit-arity-mismatch`, `edit-import-breakage` register in `FINDING_CODE_REGISTRY` with
   source-declared severities, advisory by default, emitted in the unified `GovernanceFinding`
   shape. `check-edit --hook` resolves those codes through the shared policy machinery; general
   `enforce` and review ingestion remain separate collectors.

**Deliberately NOT borrowed** from the verification-loop literature: no typechecker or compiler
invocation (that is the opt-in LSP evidence tier's territory, `add-lsp-evidence-tier`), no test
execution (OpenLore never runs tests), no LLM judgment of severity. The verdict is the sound,
provable subset — reference existence, arity bounds, export presence — computed from facts the
graph already holds, with everything unprovable staying silent.

## Why this is in scope

This closes the substrate's loop-latency gap: OpenLore currently knows about breakage before
any other tool on the machine and tells the agent last (at commit). Turning patch-time knowledge
into a sub-second conclusion is the "deterministic checker inside the agent's turn" pattern the
evidence ranks first, built entirely from shipped machinery — watcher, edge lines, retained
full-analysis reachability, finding registry, and hook discipline.

## Resolved boundaries

- Whole-file deletion invalidates the prior generation but does not synthesize a fresh verdict;
  the deletion lane cannot preserve the required pre/post caller proof today.
- Reaching tests are explicitly based on the last full analysis and are content-hash checked;
  a changed source or test basis makes the verdict stale.
- Direct and hook reads never approximate missing watcher facts. Unavailable proof is a
  disclosed non-blocking result.

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
