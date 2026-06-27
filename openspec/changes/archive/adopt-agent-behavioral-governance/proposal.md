# Adopt the agent behavioral governance layer (from PR #83), staged toward the memory north star

> Status: IMPLEMENTED (PR #175, merged). Fully built on current `main` — the deterministic core plus all four "deferred" parts (gryph fail-open, `experimental_blocking`, `setup --hooks`/`--panic`, observe→memory loop) and the `panic-validate` gate; 101 panic/behavioral/gryph tests pass. The accuracy-gate clearing (turning intervention on by default) remains future work needing real observe-mode telemetry. (Status corrected 2026-06-25 — was a stale "IN PROGRESS".) Originally adopting `laurentftech`'s Panic Response Layer (PR #83,
> `feat/panic-response-layer`, ~3,822 LOC) onto current `main`. PR #83 was opened against `v2.0.1`
> and is 513 commits stale; it does not merge or compile cleanly as-is. This change rebases the work
> onto current `main` and now builds out the **full feature** in PR #175 — everything **opt-in and
> off by default**, with the observe-mode accuracy gate as the hard constraint on enabling any
> interventional posture. Work branch: `feat/agent-behavioral-governance`.
>
> UPDATE (2026-06-21): the work originally staged into follow-up PRs is now built **in this PR**,
> behind safe defaults — Gryph runtime observability (fail-open), `experimental_blocking` (opt-in),
> `setup --hooks`/`--panic` installers (opt-in, never default), the expanded observe-mode validation
> gate (`openlore panic-validate`), and the observe→memory feedback loop
> (`openlore panic-hotspots`). The four `defer-*` / `add-*` proposals are marked BUILT accordingly.
> Every default remains `off`; nothing interventional ships enabled-by-default before the gate clears.

## Why

OpenLore's true north is to be the **persistent memory and context layer that feeds AI agents useful
data so they do less labor, spend fewer tokens, and develop faster**. Everything we ship is judged
against that.

OpenLore *already* governs agents through one channel: EpistemicLease tracks per-agent behavioral
state and injects a freshness/staleness signal into every MCP tool response
(`getFreshnessSignal(tracker)` in `mcp.ts`). "Your index is stale, re-orient" is a nudge we already
emit, and it already rides on the `EpistemicTracker`. PR #83's Panic Response Layer is built on the
**same** `EpistemicTracker` and injects through the **same** content-item surface. So this is an
*extension of governance we already do*, not a pivot to a new product.

The distinction that matters: a freshness signal is a **fact** (the index commit moved), cheap to
trust. A panic signal is a **judgment** ("you appear to be thrashing"), and a wrong judgment is
negative value — it spends the tokens we exist to save and interrupts good work. Therefore the layer
earns its place **only if the signal is accurate**, and accuracy is something we must validate before
we ever let it intervene by default.

This change adopts the work in a way that keeps that discipline: land the deterministic behavioral
*observability* core (default **off**, zero overhead when off), and gate every *interventional* and
heavy-infrastructure part behind opt-in modes and follow-up PRs that must prove their value.

## What this is NOT (scope guardrails)

- **No LLM inference.** The entire layer is deterministic runtime heuristics — Shannon entropy over
  command signatures, oscillation over the module-transition sequence, hysteresis thresholds, wall-clock
  decay. There are zero model calls. The north-star determinism constraint (`c6d1ad07`) holds.
- **No new default surface.** `panicResponse.mode` defaults to `off`. When off: no scoring, no state
  file, no injection, no telemetry, no background process. Existing users are unaffected.
- **Not a pivot.** It extends the existing EpistemicLease nudge channel; it does not add a new domain,
  a new tool to the default/minimal MCP surface, or a security/threat-modeling product.

## What changes (the core that lands now)

1. **Behavioral signals on `EpistemicTracker`.** `panicScore`, `panicLevel` (L0–L4 with hysteresis),
   `localityConfidence` (shared with the freshness burst gate), and supporting fields. Computed by
   `updatePanic()`, extracted from `updateTracker()` and called **conditionally** on panic mode.
   `updateTracker()` (the freshness engine, now V4 on `main`) always runs unchanged.

2. **`panic-response.ts` + `panic-constants.ts`.** The hysteresis engine, atomic `panic-state.json`
   I/O (fail-open reads, POSIX rename writes), and a single source of truth for every threshold/weight.

3. **Opt-in mode ladder, default `off`.** `off | observe | advisory`. `observe` = scoring + state file,
   no agent impact (this is the mode we validate accuracy on). `advisory` = + a signal injected as a
   separate content item at L2+ (never concatenated into the result body, so JSON/patches stay intact).

4. **`openlore panic-check`** — the PreToolUse hook consumer. Reads state, applies cooldown,
   **always exits 0** (fail-open). Not auto-installed; the user wires it up explicitly.

5. **`openlore panic-level`** — read-only status-line output (`P:L{n}`), no writes, no side effects.

6. **Telemetry.** A `panic` domain (`panic.jsonl`) with provenance-tagged `panic_score_delta` and
   level-change events, and a panic section in `openlore telemetry`. Telemetry writes go through the
   **existing `redactSecrets()` path** (mcp-security: Secret Confinement) — the rotation logic this PR
   adds is combined with redaction, never replacing it.

## What is deferred to follow-up PRs (must prove value before landing)

These are the parts that carry real cost, external dependencies, or unproven intervention. They do
**not** land in this change.

Originally staged into follow-up PRs; now **all built in this PR (#175)** behind safe defaults. Each
is tracked by its own change proposal (now marked BUILT) so the design + gates stay documented.

| Item | Tracked proposal | Status in #175 |
|---|---|---|
| **`experimental_blocking` mode** | `defer-panic-blocking-enforcement` | BUILT — opt-in only; ladder is `off\|observe\|advisory\|experimental_blocking`. At L4 emits `{decision:block, advisory:true}`; never default. Hard-gated on the accuracy gate. |
| **Gryph integration** (`gryph-bridge`, `gryph-watch`, CAS) | `defer-gryph-runtime-observability` | BUILT — fail-open (no-op when the `gryph` binary is absent); `gryph-watch` exits silently on `off`. |
| **`setup --hooks` / `--panic` installers** | `defer-panic-setup-hooks` | BUILT — opt-in flags; never installed by a default `setup`. Enabling an interventional mode prints an accuracy-validation warning. |
| **observe → memory feedback loop** | `add-behavioral-observability-to-memory` | BUILT (end-to-end) — `openlore panic-hotspots --write` persists `behavioral-hotspots.json`; `orient()` consumes it and surfaces a contextual `behavioralHotspots` block (fail-open, gated on mode != off, labeled-only, lean-omitted). |

The expanded **observe-mode validation gate** (`openlore panic-validate`) also landed here — per-trigger
false-positive attribution, peak-level histogram, follow-through, and a `REVIEW_REQUIRED` /
`INSUFFICIENT_DATA` verdict that is never auto-`CLEARED`.

## The validation gate (the constraint that governs everything above)

**This change lands the machinery green; it does NOT prove the panic signal is accurate.** That
distinction is the most important thing in this proposal. A freshness signal is a fact ("the index
moved") and is cheap to trust. A panic signal is a *judgment* ("you appear to be thrashing"), and a
wrong judgment is negative value — it spends the tokens we exist to save and interrupts good work.

Therefore: **`observe`-mode validation is a hard gate, not a nice-to-have.** No interventional behavior
(`advisory` injection on by default, `experimental_blocking`, auto-installed hooks) ships *on by
default* until `observe`-mode telemetry from real sessions demonstrates the signal is accurate enough
to act on. Concretely, the gate the follow-up must clear:

- A measured **false-positive rate** (panic raised during work a human judges coherent) low enough that
  acting on the signal is net-positive. If focused deep work trips L2+, the signal is not ready.
- Evidence that **interventions change behavior for the better** — the `panic_intervention_outcome`
  telemetry (orient-after-intervention) trending the right way, not agents ignoring or fighting the nudge.
- A defensible **recovery story** — episodes resolve (via orient or decay), they don't oscillate.

Until that evidence exists, the layer's only sanctioned posture is `off` (default) or `observe`
(silent measurement). Shipping intervention before the gate is cleared is explicitly out of scope and
contrary to the north star. The order is: **land the substrate (this PR) → measure in `observe` →
only then consider turning anything on.**

## North-star alignment (how the core actually helps agents)

- **Saves labor/tokens only if accurate.** The core ships `observe` (silent) so we can measure
  false-positive rate against real sessions *before* any nudge reaches an agent. Intervention is gated
  on that evidence.
- **Feeds useful data — eventually as memory.** The strategic payoff is the deferred observe→memory
  loop: behavioral observability becomes input to the memory layer (where `orient` should invest),
  not just a real-time nag. This change lays the deterministic substrate that loop needs.
- **Costs nothing when off.** Default `off` means existing users and the lean first-run surface are
  untouched; the layer is pure opt-in.

## Execution discipline

- **Rebase, not merge-patch.** PR #83 is built on the V3.2 freshness engine and a since-rewritten
  `mcp.ts` response path; it does not compile after a naive conflict resolution (it imports
  `installClaudeHook`, a symbol `main` has since removed). This change integrates onto current `main`
  and lands **green** (clean `tsc` + passing suite), reviewed, before merge.
- **`record_decision` before the contract.** The `panicResponse.mode` config contract and the
  `updatePanic()`/`updateTracker()` split are architectural; record them before/with the code.
- **Preserve the contributor's work.** Nothing is thrown away. The deferred parts land later on their
  own merits; the credit and the design are Laurent's.

## Out of scope

- Verifying that the panic *signal* is correct (that is the `observe`-mode validation follow-up, not
  this integration).
- Any change to the freshness/EpistemicLease semantics. `updateTracker()` is untouched.
- Turning intervention on by default. The default is, and stays, `off` until proven.
