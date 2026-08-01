# Analyze should just work at any repo size, without the user thinking about memory

> Status: **PROPOSED** (2026-08-01). Spec only — no code in this change. Follows the memory-hardening
> that made analyze *bounded and crash-free* (#302/#304/#306/#312); this makes it *effortless* at
> scale, so a large repository needs no flags and no attention.

## The gap

OpenLore is now memory-bounded and does not crash on any realistic repository. But the CLI still
runs at Node's conservative default heap. On a very large repository the call graph itself (its
nodes and edges) can exceed that default, and the user's only recourse is to know to pass
`--max-old-space-size` by hand. "It works if you set a Node flag" is not "it just works" — it asks
for exactly the attention we want to eliminate.

## The promise, stated honestly

OpenLore SHALL analyze any repository that fits the machine, with no flags and no attention. When a
repository genuinely exceeds the machine, it SHALL degrade gracefully and disclose what it reduced,
in one line — never abort with a raw V8 fatal. "Any size" is bounded by your RAM; we make the common
case fully automatic and the over-capacity case survivable, instead of asking anyone to tune a heap.

## What changes — four pillars

1. **Adaptive heap sizing.** The CLI sizes its own heap to the machine: a generous fraction of
   *available* memory — the container/cgroup limit when one is present, not merely `os.totalmem()` —
   by re-executing itself once with the right `--max-old-space-size`. It is idempotent (never loops),
   honors an explicit override and any `NODE_OPTIONS` the user already set, is transparent to the
   stdio MCP server, and logs the chosen size once so the behavior is observable, not magic.

2. **A cheap pre-flight capacity signal.** Before the heavy passes, estimate the graph's memory from
   the repository's own size (file count and bytes — already produced by the repository mapper). Use
   it to pick the heap tier and, when the repository is near the machine's ceiling, choose the
   reduced-fidelity path *up front* rather than discover the ceiling by crashing partway through.

3. **A graceful-degradation ladder, disclosed.** When even the largest sane heap will not hold
   full-fidelity analysis, shed the most expensive, least-essential work first, in a defined order
   (CFG/def-use overlay → deep-analysis breadth → …), so the user still gets a working index. What
   was reduced is disclosed in the artifact through the existing parse-health / exclusion machinery
   and in one CLI line, so a downstream conclusion never reads reduced coverage as genuine absence.

4. **Determinism preserved.** Memory management SHALL NOT change the produced artifact. Heap size and
   buffer-vs-spill choices are already byte-identical (the CFG spill proved this). Only the explicit
   degradation path may reduce content, and it does so as a function of *declared* constraints
   (available memory, repository size) — disclosed and reproducible — never a silent,
   machine-dependent difference between two "full" runs of the same repository.

## Why this shape

- Auto-heap-sizing removes essentially every real-world OOM with a small, safe change and zero user
  attention — the 80/20 of "just works."
- The honest degradation ladder keeps the crash-free guarantee from #302/#312 true even past the
  machine's capacity, without a raw fatal and without silently dropping data undisclosed.
- Keeping memory management artifact-neutral protects OpenLore's core determinism promise; making
  degradation explicit, ordered, and disclosed is what lets us scale without lying about coverage.

## Deliberately NOT in scope

- **Out-of-core / streaming graph** — persisting the node/edge graph to SQLite and never holding it
  whole. That is the only thing that makes a graph *larger than RAM* analyzable, but it is a large
  architectural bet, and adaptive heap plus graceful degradation cover the practical need. If a real
  user hits the RAM ceiling at normal function density, that earns its own proposal — this change
  deliberately does not pre-commit to it.
- **The embeddable in-process API** cannot re-execute the process; its heap is the host's. This
  change is the CLI happy path. The API path documents that the host owns the heap and that the
  degradation ladder still applies within whatever heap the host provides.
- **A perpetual heap-growth loop.** Re-execution happens at most once per invocation; the pre-flight
  estimate, not repeated failures, chooses the size.
