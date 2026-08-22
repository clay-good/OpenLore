# Tasks — fix-windows-invocation-surface

## Implementation
- [ ] Shared `resolvePlatformCommand` helper (dependency-light, one home): on win32 discover and
      validate the absolute npm CLI entry point, then invoke it through the absolute running
      `node.exe`; pass commands through unchanged on other platforms
- [ ] Update evidence probes and upgrade execution use the helper so npm runs on Windows instead
      of ENOENT→127; keep install classification behavior in `fix-update-install-detection`
- [ ] Install adapters emit platform-correct commands at generation time: claude-code.ts:38
      (MCP `command: 'npx'`), :56-57 (hook commands), cursor.ts:30, continue.ts:23
- [ ] Working-or-disclosed decision: EITHER a Windows CI smoke job (install → `--version` →
      `analyze` on a fixture) OR a README support matrix (Windows: best-effort, tier 2) plus a
      one-line `doctor` platform notice on win32; document which was chosen and why

## Verification
- [ ] Unit tests for the helper: win32 resolves npm/npx to absolute Node + validated CLI-entry
      argv, including separate npm prefixes and missing-entry failure; darwin/linux pass through
      unchanged
- [ ] Adapter tests: configs generated under mocked win32 contain the resolvable command; configs
      on darwin/linux byte-identical to today
- [ ] `update --dry-run` test under mocked win32 prints the resolved command (no execution needed
      to verify the argv)
- [ ] If the CI smoke job is chosen: it runs green on windows-latest; if the support-tier path is
      chosen: README states the matrix and doctor emits the notice on win32
- [ ] Full suite green on macOS/Linux (no behavior change off win32)

## Spec
- [ ] `cli` delta: ADD WindowsInvocationResolvesOrDiscloses
