# Tasks — fix-windows-invocation-surface

## Implementation
- [x] Shared `resolvePlatformCommand` helper (dependency-light, one home): on win32 discover and
      validate the absolute npm CLI entry point, then invoke it through the absolute running
      `node.exe`; pass commands through unchanged on other platforms
- [x] Update evidence probes and upgrade execution use the helper so npm runs on Windows instead
      of ENOENT→127; keep install classification behavior in `fix-update-install-detection`
- [x] Install adapters emit platform-correct commands at generation time: claude-code.ts:38
      (MCP `command: 'npx'`), :56-57 (hook commands), cursor.ts:30, continue.ts:23
- [x] Working-or-disclosed decision: Windows CI smoke job chosen (pack/global install → `--version`
      → generated-launcher execution → `init` → `analyze` on a fixture), with Windows support stated
      in README; this tests the published boundary and keeps support claims evidence-backed

## Verification
- [x] Unit tests for the helper: win32 resolves npm/npx to absolute Node + validated CLI-entry
      argv, including separate npm prefixes and missing-entry failure; darwin/linux pass through
      unchanged
- [x] Adapter tests: configs generated under mocked win32 contain the resolvable command; configs
      on darwin/linux byte-identical to today
- [x] `update --dry-run` test under mocked win32 prints the resolved command (no execution needed
      to verify the argv)
- [x] Windows Smoke passed on `windows-latest` in PR #391 (5m50s); the README states Windows and
      Linux CI coverage and macOS support without claiming a macOS CI runner
- [x] Linux CI Unit Tests passed (5m6s). On macOS, 8,111 tests passed in the broad run; six
      load-sensitive timeout cases then passed 112/112 in isolation, and e2e passed 187/187

## Spec
- [x] `cli` delta: ADD WindowsInvocationResolvesOrDiscloses
