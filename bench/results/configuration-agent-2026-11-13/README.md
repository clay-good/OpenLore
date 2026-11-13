# Live configuration agent evidence — 2026-11-13

See [protocol, findings and limitations](../../../docs/configuration-assistant-agent-trial.md).

- `initial.*`: independent participant before schema correction (five refused previews, then success).
- `corrected.*`: fresh participant after shared schema/skill correction (first preview succeeds).
- `*.mcp.jsonl`: actual tool arguments, results and host approval decisions; fixture directory arguments normalized to `<fixture>`.
- `*.result.json`: filesystem/receipt oracle results. `sourceCommit` is the base; `sourceTreeDirty` records changes present at assessment. `assessmentCliSha256` hashes the CLI at assessment, not retroactively at initial execution.
- `corrected.tools-list.json`: real corrected tools/list response used for schema discovery.
- Response Markdown: actual user-visible participant messages/excerpts, transcribed without private reasoning.
- `native-codex.result.json`: authentication failure before any OpenLore call; **not a pass**.

Approval was supplied by the test controller after checking each exact plan. Neither journey had a live daemon/index. These are qualitative observations, not expected fixtures, CI tests or a model success-rate benchmark.
