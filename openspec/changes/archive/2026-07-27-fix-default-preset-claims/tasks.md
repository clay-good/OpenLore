# Tasks — one default, said once

## Implementation
- [x] serve.ts → `options.preset ?? LEAN_DEFAULT_PRESET` AND the commander `--preset` default
      (the effective default; the proposal missed this second literal); update serve.ts:11 comment,
      the `~60 tools` comment, and the examples/help
- [x] Correct help strings: mcp.ts `--preset`/`--all-tools`, install/index.ts, connect.ts, top-level
      `mcp` blurb; interpolate the constant where a preset name is stated
- [x] Correct stale comments/docstrings: claude-code.ts adapter, resolvePresetName/selectActiveTools/
      leanDefaultActive docstrings + breadth comment, the substrate-preset banner (now the active default)
- [x] docs/mcp-tools.md:44 — rewrote the navigation entry as "the lean escape", left :63 as the
      default; also fixed two live reference docs (cli-reference.md serve entry, governance-dogfooding.md)
- [x] Drift-guard test (default-preset-single-source.test.ts): no preset-name literal used as a `??`
      fallback default in mcp/serve/connect/install adapter; serve default resolves through the constant;
      `--help` output names the default via the constant
- [x] CHANGELOG entry disclosing the serve default change (10 → 13 tools)

## Verification
- [x] `openlore mcp --help`, `install --help`, `connect --help` all state substrate as default (live-checked)
- [x] `openlore serve` /health reports the substrate preset (live-checked: preset=substrate, 13 tools, recall present)
- [x] full `vitest run src examples` green (294 files / 5744 tests); guard test red if any call site hardcodes a preset
- [x] `openlore analyze` runs clean end-to-end (change doesn't break OpenLore)

## Spec
- [x] `cli` delta: ADD DefaultPresetHasOneSource
