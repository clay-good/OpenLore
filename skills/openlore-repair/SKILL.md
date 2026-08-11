---
name: openlore-repair
description: Reconcile one existing OpenSpec specification from deterministic OpenLore MCP observations. Use when a spec may be incomplete, stale, partially covered, or orphaned from current code.
---

1. Call `prepare_spec_repair` for the existing spec domain, then exhaust `receipt.continuationCursor` pages in order.
2. Honor mapping-coverage availability. `mappingCoverage.state = "unavailable"` means the links could not be established, so every mapping-dependent metric is `null` — never read `null` as zero gaps, and never re-run the same audit hoping for a different answer. Apply the exact remediation in `receipt.followUps` (`openlore analyze`, `openlore mapping refresh`, or writing an explicit anchor).
3. Treat `staleMapping` as evidence about the SPEC: a requirement whose exact anchor no longer resolves. Repoint it at the current symbol or remove the claim; do not silently keep an anchor to a symbol that is gone.
4. Semantically reconcile additions and corrections together. Never delete an orphan requirement solely from a structural observation.
5. Give every requirement you add or repair an exact implementation anchor: `- **Implementation**: \`symbolName::path/to/file.ts\`` (or `path/to/file.ts#symbolName`). Write one only when the evidence names that exact symbol; a file-only reference never establishes function coverage, and a guessed symbol is worse than no anchor.
6. Use receipt-directed follow-ups only, edit with native host tools, and validate strictly.
7. Finalize: after validation, run `openlore mapping refresh` when shell access is available so the persisted link index matches the spec you edited. If you cannot run it, say so explicitly — correctness is unaffected, because audit and Repair re-derive the index in memory, and only the cache is stale.

Do not reconstruct domains, coverage, drift, historical paths, or structural scope in this skill.
