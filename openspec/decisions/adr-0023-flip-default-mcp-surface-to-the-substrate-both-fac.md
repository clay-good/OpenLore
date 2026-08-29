# ADR-0023: Flip default MCP surface to the substrate (both-faces) preset

## Status

accepted

**Domains**: analyzer, drift, cli

## Context

Benchmark-cleared. The DefaultSurfaceRevealsAllFaces gate ran all three quantities and none regressed: (1) token economy — substrate ~4.5k tokens, +1.2k over navigation, within the ~10k tool-search threshold; (2) face coverage — substrate exposes navigate+change+remember+verify, navigation only navigate; (3) selection accuracy — substrate 90% vs navigation 80% on shared tool selection (no regression) and 100% vs 0% on governance, plus end-to-end task COMPLETION on the pinned real-repo corpus across TWO models (sonnet + haiku) on BOTH tiers: 100% correctness everywhere, substrate cheaper on 3 of 4 model×tier cells. The lean navigation default under-sold the substrate: agents installed the documented way never discovered recall/verify_claim/blast_radius.

The consolidated run evidence is checked in at
`bench/results/adr-0023-default-surface.json` under the reusable protocol in
`bench/PROTOCOL.md`.

## Decision

The system SHALL expose the substrate preset (navigation core plus recall, verify_claim, and blast_radius) as the default MCP tool surface.

## Consequences

The out-of-box default install now exposes the substrate preset (navigation core + recall + verify_claim + blast_radius, 13 tools) instead of navigation (10). No tool removed; navigation stays a named preset and is a one-flag reversible escape (--preset navigation). Reverses ADR-0022 (a6c916ed). Lean-default payload budget rises ~13.2KB to ~17.7KB. The BREADTH_POINTER now describes the substrate default and points to full/federation/navigation. Docs/guards updated to the 13-tool default.

> Recorded by openlore decisions on 2026-06-28
> Decision ID: c79ec7ca
