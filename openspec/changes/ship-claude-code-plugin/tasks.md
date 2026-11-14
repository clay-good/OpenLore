# Tasks

## 1. Plugin and launcher (PR #727)

- [x] 1.1 Spike: validate, size, real install, time against 60 s, review rules (results in proposal.md).
- [x] 1.2 `plugin/` layout, `.claude-plugin/marketplace.json`, icon. Test: `src/cli/install/plugin-manifest.test.ts`.
- [x] 1.3 Launcher `plugin/runtime/openlore.mjs`: lean install into `${CLAUDE_PLUGIN_DATA}`, hooks never wait, MCP waits. Accept: `scripts/plugin-smoke.mjs` passes.
- [x] 1.4 Duplicate wiring: plugin hooks stay silent when `openlore install` hooks exist. Accept: smoke check 5.
- [x] 1.5 README: what it runs, writes, fetches, and sends. Accept: `claude plugin validate plugin --strict --profile directory` passes.
- [x] 1.6 CI: strict validation in `build`; `plugin-smoke` job on Linux, Windows, macOS at Node 22.22.0.
- [x] 1.7 `scripts/sync-plugin-version.mjs` and the release step in `docs/publishing.md`.

## 2. Before the directory submission

- [ ] 2.1 Use the plugin daily for one week through the self-hosted marketplace on macOS, Windows, and Linux; record problems in this file.
- [ ] 2.2 After 3.7.0 is on npm: run `node scripts/sync-plugin-version.mjs 3.7.0`; merge `chore(plugin): pin openlore 3.7.0`. Accept: `plugin-smoke` passes on all three OS.
- [ ] 2.3 `openlore doctor` reports when both the plugin and CLI wiring are present, and names `openlore uninstall`. Files: `src/cli/commands/doctor.ts`. Test: a doctor test with a settings file carrying `_openlore` hooks and a plugin entry in `installed_plugins.json`.
- [ ] 2.4 Submit at claude.ai/directory/manage. Expect a human hold for the runtime install; answer the data-handling questions from the README's disclosure.

## 3. Later

- [ ] 3.1 Opt-in hooks (`before-edit`, `before-subagent`, `subagent-start`) through a documented setting, after `hook-reliability` sets latency budgets.
- [ ] 3.2 Reduce the runtime further if the native grammars can load per language on demand.
