# Panic blocking enforcement — `experimental_blocking` mode (deferred follow-up from PR #83)

> **UPDATE (2026-06-21): BUILT in PR #175** — `experimental_blocking` is back on the ladder as an
> EXPLICIT opt-in (never default); at L4 it emits `{decision:block, advisory:true}`. Still hard-gated
> on the accuracy gate before any default-on use. History below.
>
> Status: BUILT (PR #175, merged; see the UPDATE banner above). Status line corrected 2026-06-25 — was a stale "DEFERRED". History: removed from the mode ladder in PR #175 (now `off | observe | advisory`).
> Preserves @laurentftech's L4 enforcement design (PR #83). HARD-gated on validated signal accuracy.

## Why it was deferred

`experimental_blocking` is the only *interventional enforcement* posture: at L4 the `panic-check` hook
emits `{"decision":"block","advisory":true}` to the runtime. Shipping an enforcement mode — even an
opt-in, advisory-flagged one — before the panic signal is shown to be accurate inverts the risk: a
false positive doesn't just spend tokens, it can block a correct tool call. OpenLore's posture is that
the signal must earn the right to intervene.

## What it restores (Laurent's design, intact)

- `PanicResponseMode` gains `'experimental_blocking'` again.
- `panic-check.ts`: at `mode === 'experimental_blocking' && panicLevel >= 4`, emit
  `{ decision: 'block', advisory: true, panicLevel, message }` and exit 0. `advisory: true` is always
  present — the runtime decides enforcement; OpenLore never mandates.
- `mcp.ts`: include `experimental_blocking` in the response-injection condition.

Recoverable from PR #83 (`feat/panic-response-layer`).

## Gate (hard)

Blocked on the observe-mode accuracy gate (`adopt-agent-behavioral-governance`). Specifically, before
this ships even as an opt-in mode:
- the false-positive proxy must be low enough that a wrongful block is rare, and
- advisory-mode follow-through must show agents act on the signal rather than fight it.

Until then, the maximum sanctioned posture is `advisory` (a separate content item the agent may heed
or ignore), never a block.

## Out of scope

- Any default-on enforcement. Even after landing, `experimental_blocking` stays explicitly opt-in.
