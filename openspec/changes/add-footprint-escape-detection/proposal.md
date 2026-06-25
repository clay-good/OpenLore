# Footprint escape detection: flag when an agent's actual diff leaves its declared write-footprint, and recompute the conflicts that opens

> Status: SHIPPED (2026-06-24). Part of the `PARALLEL-WORK-COORDINATION.md` set (proposal 3, the
> back-side safety net). Extends the existing `structural_diff` to compare an actual diff against a
> task's declared write-footprint, flag symbols modified *outside* it, and recompute the peer
> conflicts that escape newly opens. This is what closes the soundness gap a *predicted* footprint
> leaves open. Stateless, advisory.
>
> **Implementation:** the pure escape core is `src/core/services/mcp-handlers/footprint-escape.ts`
> (`analyzeEscape` + `normalizeDeclaredFootprint`); `structural_diff`
> (`src/core/services/mcp-handlers/structural-diff.ts`) computes the diff's actually-modified
> symbols — including body-only changes, via a line-subsequence edit-nature check that separates a
> `pure-addition` (a new switch case) from a `modifies-existing` edit — and runs the analysis when a
> `declaredFootprint` is supplied. Three finding codes (`footprint-escape`,
> `footprint-escape-new-conflict`, `mis-declared-append`) are registered in `FINDING_CODE_REGISTRY`,
> advisory by default, opt-in blocking via `enforcement.policy`. No new MCP tool. Verified by 40
> co-located tests (`footprint-escape.test.ts`, `structural-diff-escape.test.ts`), the full suite
> (247 files green), and a dogfood on this repo's real working tree (see
> `DOGFOOD-footprint-escape-detection.md`).
>
> **Adversarial hardening round (post-review, 2026-06-24).** Three parallel adversarial audits drove
> fixes: (1) **CRITICAL** — `structural_diff` sliced symbol source by tree-sitter offsets using
> `Buffer.subarray` (BYTE offsets), but the node binding reports UTF-16 **code-unit** offsets; on any
> multibyte file this corrupted the slice and could misclassify or silently drop a real escape. Fixed
> to `content.slice` (matching every other slice site); proven with a heavily-multibyte end-of-function
> regression. (2) the empty/non-code-diff early return silently dropped a supplied footprint — now
> emits a vacuous `escapeAnalysis` with a note. (3) a degenerate (empty/malformed) declared write-set
> is now disclosed instead of producing a silent full-diff escape storm. (4) `maxResults` truncation is
> disclosed and **always retains blocking findings** so a `gated` result can never hide its cause. (5)
> the opt-in blocking path is now tested end-to-end (a config `enforcement.policy` flips a code to
> blocking → `gated: true`); the `removed`-into-peer reason wording, multi-peer, self-skip, and
> planned-overlap-exclusion paths are covered; and the `RegistryCollisionResolution` spec was reconciled
> to the honest stateless reality (one realized diff + the peer's *declared* append).

## Why

Proposals 1 and 2 plan a swarm from *predicted* footprints — declared write-sets plus deterministic
reachability. That prediction is advisory by construction: an agent can, and sometimes will, edit
outside its declared region (add a helper to a "borrowed" file, rename a symbol nobody scoped, reach
into a shared utility). A borrow checker that can only *advise* and never *enforce* is exactly half a
borrow checker — the missing half is the check that runs *after* the code is written and says "this
diff escaped its declared borrow." Rust gets soundness because the compiler runs that check and
rejects the violation; OpenLore cannot reject, but it *can* detect the escape and hand the verdict to
whoever can act on it (the harness, CI, or the human).

OpenLore already has the after-the-fact half: `structural_diff` computes what a diff actually touched.
The only missing piece is comparing that actual footprint against the task's *declared* one and
recomputing the conflict graph deltas. That is a small, deterministic extension — and it is the
difference between "we planned this swarm and hoped" and "we planned it, and we know the moment an
agent broke the plan."

## What changes

1. **An optional declared-footprint input to `structural_diff`.** When a caller passes a task's
   declared write-footprint (the same structure proposal 1 produces, typically captured at plan time),
   `structural_diff` additionally computes the **escape set**: symbols/files the diff actually modified
   that lie *outside* the declared write-set. With no declared footprint passed, behavior is exactly as
   today (pure additive extension).

2. **Escape classification.** Each escaped symbol is labeled by how it escaped:
   - **out-of-scope write** — a symbol modified that was not in the declared write-set at all;
   - **read-set intrusion** — a symbol modified that was only in the declared *read*-set (the task was
     supposed to read it, not change it);
   - **scope creep within file** — a new symbol added to a declared file (lower severity).

3. **Conflict re-computation on escape.** Given the escape set and the *other* in-flight tasks'
   declared footprints (supplied by the caller — OpenLore holds no roster), recompute the hazards the
   escape *newly opens*: an out-of-scope write that lands in a peer's write-set is a freshly-created
   WAW that the original plan did not have. The output names the specific peer task(s) now in conflict.
   This mirrors `change_impact_certificate`'s "paths newly opened" differential, applied to the swarm
   conflict graph.

4. **Registry-collision resolution (the back-side of `shared-append`).** Because `structural_diff`
   sees the *actual* diffs, it can confirm what the plan-time `shared-append` heuristic could only
   assume. When two tasks both touched the same registration symbol (a dispatcher, a registry array, a
   preset list) and both edits are **disjoint additions** — new branches/elements at non-overlapping
   locations — the collision is reported as **resolved-by-merge**, not a conflict. Only an edit that
   actually *modifies an existing member* of that symbol (or two additions that genuinely overlap) is
   reported as a real WAW. This closes the loop opened in proposal 1: the planner downgrades declared
   appends optimistically; escape detection verifies them against reality and catches the case where an
   agent claimed `append` but in fact rewrote shared code.

5. **Stateless and advisory.** No roster of agents or tasks is stored; the caller passes the declared
   footprint and the peer footprints it wants checked. The result is a finding, never a block by
   default; a repo MAY opt the "diff escaped its declared footprint and created a new WAW" finding into
   blocking via `enforcement.policy`. Enforcement (reject the diff, re-plan the swarm) is the harness's
   job, not OpenLore's.

6. **Determinism & honesty.** The escape set and the newly-opened conflicts are a deterministic
   function of the diff, the declared footprint, and the supplied peer footprints. If no declared
   footprint is supplied, the feature is dormant and `structural_diff` is unchanged. The disclosure
   stands: detection is structural, so an escape that creates only a *semantic* (non-call, non-write)
   conflict can still slip through — escape detection narrows the soundness gap, it does not close it.

## Decision

**Extend `structural_diff` with an optional declared-footprint comparison rather than adding a new
tool.** The actual-footprint computation already lives in `structural_diff`; bolting the
declared-vs-actual delta and the newly-opened-conflict recomputation onto it keeps one diff-analysis
surface and keeps the tool count flat. The declared footprint and peer footprints are *inputs*, not
state OpenLore holds — preserving the stateless `render(state)` discipline. The check is advisory; the
harness enforces.

## Scope contract — do not break these things

This change must NOT:
- Change `structural_diff`'s behavior when no declared footprint is supplied. The extension is purely
  additive and dormant by default.
- Store a roster of agents, tasks, or in-flight footprints. The caller supplies declared and peer
  footprints per call; OpenLore holds nothing across calls.
- Block a diff or reject a write by default. It emits a finding; gating is opt-in via
  `enforcement.policy`; enforcement is the harness's responsibility.
- Add a new MCP tool. The capability rides the existing `structural_diff`.
- Claim it makes the plan sound. Escape detection catches *structural* escapes (out-of-scope writes,
  read-set intrusions, new WAW); it cannot catch a purely semantic conflict, and the output says so.

## Out of scope (deferred)

Automatically re-planning the swarm on escape (the harness re-invokes `plan_parallel_work` with the
new actual footprints — OpenLore just supplies the signal); detecting semantic/latent-invariant
escapes (out of static-analysis reach); a learned severity model for escapes; and persisting escape
history (the harness or git history holds that).

## Implementation status

Tracked in `tasks.md`. Verified by: a diff that stays within its declared write-set reports an empty
escape set; a diff that modifies a symbol outside the declared write-set reports it as an out-of-scope
write; a diff that modifies a symbol that was only in the read-set reports a read-set intrusion; an
out-of-scope write that lands in a supplied peer footprint's write-set reports a newly-opened WAW
naming that peer; `structural_diff` with no declared footprint is byte-identical to today; and the
result is deterministic and carries the semantic-escape disclosure.
