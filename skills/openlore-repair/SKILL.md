---
name: openlore-repair
description: Reconcile one existing OpenSpec specification from deterministic OpenLore MCP observations. Use when a spec may be incomplete, stale, partially covered, or orphaned from current code.
---

1. Call `prepare_spec_repair` for the existing spec domain.
2. Honor the receipt and mapping-coverage availability; unavailable never means zero gaps.
3. Semantically reconcile additions and corrections together. Never delete an orphan requirement solely from a structural observation.
4. Use receipt-directed follow-ups only, edit with native host tools, and validate strictly.

Do not reconstruct domains, coverage, drift, historical paths, or structural scope in this skill.
