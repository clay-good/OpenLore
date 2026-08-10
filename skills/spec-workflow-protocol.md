# OpenLore specification workflow protocol

- Generate calls `prepare_spec_generation`; Repair calls `prepare_spec_repair`.
- Host integrations consume the receipt before authoring.
- Continuation cursors are exhausted in order; atomic tools are called only when a receipt names them.
- Hosts never reclassify files, infer domains, recompute mapping coverage, or broaden structural scope.
- OpenLore provides deterministic observations only. The host authors, edits, and validates OpenSpec prose.
- Unavailable evidence is disclosed as unknown, never converted to an empty conclusion.
