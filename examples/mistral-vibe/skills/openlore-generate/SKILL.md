---
name: openlore-generate
description: Author a new OpenSpec domain specification from deterministic OpenLore MCP evidence. Use when asked to reverse-engineer, generate, or document a specification for existing code.
---

1. Call `prepare_spec_generation` for the reconciled domain; never infer domains from paths.
2. Exhaust `receipt.continuationCursor` pages in order and call atomic tools only when named in `receipt.followUps`.
3. **Stop for the human when `overlap` reports material sharing with an existing spec.** The observation is deterministic evidence, not a verdict: OpenLore never decides whether the requested domain is a business boundary, a technical layer, or a duplicate. Report the shared files and symbols and ask whether to extend the existing spec, rename the candidate, or create a new one. Do not silently author a competing spec.
4. Author one baseline spec from the evidence using RFC 2119 requirements and `####` GIVEN/WHEN/THEN scenarios.
5. Give every requirement an exact implementation anchor: `- **Implementation**: \`symbolName::path/to/file.ts\`` (or `path/to/file.ts#symbolName`). Write an anchor only when the evidence names that exact symbol — a file-only reference is domain-footprint evidence and never establishes function coverage, and a guessed symbol is worse than no anchor. These anchors are what the deterministic link index reads back, so a spec without them reports as `unmapped`, not as covered.
6. Use native host editing and strict OpenSpec validation. Never invent behavior or ask OpenLore to write prose.
7. Finalize: after validation, run `openlore mapping refresh` when shell access is available so the persisted link index matches the spec you wrote. If you cannot run it, say so explicitly — correctness is unaffected, because audit and Repair re-derive the index in memory, and only the cache is stale.

Do not reconstruct inventories, signatures, relationships, or domain membership in this skill.
