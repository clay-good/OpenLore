# Behavioral observability → memory (the north-star follow-up)

> **UPDATE (2026-06-21): BUILT (end-to-end) in PR #175** — `openlore panic-hotspots` aggregates
> per-module destabilization and `--write` persists `behavioral-hotspots.json`; `orient()` now
> consumes it, surfacing a contextual `behavioralHotspots` block when the task targets a labeled
> hotspot module (fail-open, gated on mode != off, omitted in lean mode). The observe→memory loop
> runs end to end. History below.
>
> Status: PROPOSED (not yet built) — the piece of the behavioral-governance work that most directly
> serves OpenLore's north star. Build after `adopt-agent-behavioral-governance` has gathered
> observe-mode data. New design (not from PR #83), but it is the reason the behavioral substrate is
> worth keeping.

## Why this is the real payoff

OpenLore's north star is a persistent memory/context layer that feeds agents useful data so they do
less work and spend fewer tokens. The panic layer, on its own, is real-time *intervention* — a nudge.
The durable value is the inverse: turn the behavioral *observations* into **memory**.

If observe-mode telemetry shows "agents reliably destabilize in module X on this repo" — high
oscillation, repeated stale-depth-3, repeated orient churn around the same code — that is exactly the
signal that says *this is where `orient`/anchored memory should invest*. The panic engine already
computes this deterministically; today it only spends it on a momentary nudge. This change feeds it
back into the memory layer so the *next* agent arrives better-oriented, instead of being nudged after
it is already lost.

## What changes

1. **A deterministic aggregation** over `panic.jsonl` + `epistemic-lease.jsonl`: per-module
   destabilization frequency (episodes, peak level, oscillation, orient churn) — read-only, no LLM.
2. **A memory/orient signal**: surface the top destabilization hotspots as a durable, code-anchored
   note (reusing the existing `remember`/anchored-memory machinery) so `orient` can pre-warn or
   pre-load context for those regions.
3. **Feeds the agent before the work, not after** — the difference between "you got lost, re-orient"
   (intervention) and "this area is where agents get lost, here's the map" (memory). Only the latter
   reduces labor and tokens.

## What does NOT change

- **No LLM.** Aggregation is deterministic; the hotspot note is generated from counts, not inference.
- **No intervention.** This is the observability→memory direction; it does not nudge or block.
- **Opt-in / data-gated.** Requires `observe`-mode data to exist; absent data, it is a no-op.

## Dependencies

- `adopt-agent-behavioral-governance` (the deterministic behavioral substrate + observe-mode telemetry).
- Reuses anchored-memory (`remember`/`recall`) and the existing `orient` insertion path.

## Out of scope

- Real-time behavior; this is an offline/aggregation pass over telemetry into memory.
- Any composite "destabilization score" tuning knob — surface labeled counts, let `orient` rank.
