---
name: openlore-generate
description: Author a new OpenSpec domain specification from deterministic OpenLore MCP evidence. Use when asked to reverse-engineer, generate, or document a specification for existing code.
---

1. Call `prepare_spec_generation` for the reconciled domain; never infer domains from paths.
2. Exhaust `receipt.continuationCursor` pages in order and call atomic tools only when named in `receipt.followUps`.
3. Author one baseline spec from the evidence using RFC 2119 requirements and `####` GIVEN/WHEN/THEN scenarios.
4. Use native host editing and strict OpenSpec validation. Never invent behavior or ask OpenLore to write prose.

Do not reconstruct inventories, signatures, relationships, or domain membership in this skill.
