# Tasks — make analyze scale to any repo size

> Status: **PROPOSED** (spec only). No code in this change. Tasks below are the implementation plan
> for when it is built; all unchecked by design.

## Adaptive heap sizing (CLI)
- [ ] At CLI entry (`src/cli/index.ts`), before command dispatch: detect the memory budget — read the
      cgroup/container limit when present (`/sys/fs/cgroup/.../memory.max` etc.), else `os.totalmem()`
- [ ] If the current `--max-old-space-size` is below the target fraction of the budget AND the user
      has not set a heap (`--max-old-space-size`, `NODE_OPTIONS`) AND the opt-out is unset AND the
      re-exec marker is unset: re-exec `process.execPath` with the computed `--max-old-space-size`,
      passing argv/env through, setting the marker
- [ ] Marker (e.g. an internal env var) makes re-exec at-most-once; verify no loop under any outcome
- [ ] Transparent to stdio: the re-exec must not touch the JSON-RPC stream used by `openlore mcp`
      (inherit stdio; no banner on stdout — the one-line heap disclosure goes to stderr)
- [ ] One-line disclosure of the chosen heap (stderr); documented opt-out env var
- [ ] Add the opt-out + the sizing fraction to config/docs; add `OPENLORE_*` knobs consistent with
      the existing set (e.g. an opt-out and an explicit-budget override)

## Pre-flight capacity estimate (analyzer)
- [ ] Derive a conservative memory estimate from `repoMap.summary` (file count, bytes) before Phase 3
- [ ] Map the estimate + available heap to a strategy: full fidelity vs. a degradation tier
- [ ] Estimate is deterministic for a given repository (no wall-clock/RAM inputs into the number
      itself — only into the strategy choice)

## Graceful-degradation ladder (analyzer)
- [ ] Define the tier order (overlay → deep-analysis breadth → …) and the trigger thresholds
- [ ] Wire each shed tier to a disclosure via the existing parse-health / `FileExclusionReason` /
      boundary machinery (add a memory-pressure reason/among the existing disclosure surfaces)
- [ ] Surface one CLI line summarizing what was reduced and why
- [ ] Guarantee a usable index (call graph + search) is always produced within the reduced tier
- [ ] Never let a raw V8 fatal be the outcome when the reduced tier fits

## Determinism guardrails (tests)
- [ ] Test: two heap sizes / two spill thresholds → byte-identical artifact on a fixed repo (extend
      the existing analyze-twice byte-diff e2e)
- [ ] Test: degradation is a pure function of declared constraints (same budget + repo → same shed
      tiers + same disclosure)
- [ ] Test: over-capacity repo produces a usable, disclosed, reduced index instead of a fatal
- [ ] Test (CLI): re-exec is at-most-once, respects user heap / `NODE_OPTIONS` / opt-out, and is
      transparent to stdio (mcp JSON-RPC unaffected)

## Docs
- [ ] README / docs: state the honest promise — "works to your machine's capacity, degrades
      gracefully and transparently beyond it, never crashes" — and the opt-out
- [ ] Note the embeddable API path: host owns the heap; the degradation ladder still applies within it

## Explicitly deferred
- [ ] Out-of-core / streaming graph (graph larger than RAM) — its own proposal if ever needed
