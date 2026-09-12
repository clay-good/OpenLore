## 1. Quote what the shell needs quoted (#484)

- [x] 1.1 Quote a space-free entry path — @L4XB's outcome, with their two test cases.
- [x] 1.2 Invert the mechanism from a denylist to the allowlist `quotePosix` already uses, so
  the BARE branch stops being a second, unmodelled quoting rule (`a;id` alone runs `id`).

## 2. Refuse what no quoting form can carry

- [x] 2.1 Add `windowsQuotingHazard`: a scanner mirroring bash's double-quote rule (a backslash
  escapes only `` $ ` " \ `` and newline; `$` expands only before a valid parameter start, so a
  path like `C:\Users\dev$\…` is still accepted).
- [x] 2.2 Throw from `formatPlatformCommand` on an unrepresentable win32 part, naming the part
  and the reason.
- [x] 2.3 Export `windowsCommandHazard` for the callers that must not throw.

## 3. Make the refusal survivable

- [x] 3.1 `claude-code`: check before the write, then wire everything that does not need a
  shell string and omit ONLY the hooks, with the reason — not a conflict, which failed the run
  and skipped the index build.
- [x] 3.1a `claude-code`: strip a hook wired earlier on a host that can no longer run it,
  keeping any user-authored entry in the same group.
- [x] 3.2 `claude-code`: extract `MANAGED_HOOKS` so uninstall never formats a command.
- [x] 3.3 `continue`: decline `.continue/config.json` with the reason, also without conflicting
  — Continue being unwirable must not undo a Claude Code install from the same pass — and
  derive the argv once, so the hazard check and the emitter cannot ask about different commands.
- [x] 3.4 `update`: `printableCommand` prints the plain package-manager instruction on Windows
  — the resolved form is a string expression in PowerShell, not a command.

## 4. Let a real shell be the judge

- [x] 4.1 Add `platform-command.posix-oracle.test.ts`: emitted line → `bash` → argv, pinning
  #483's mangled path, the old predicate, the executed injection, and a 600-case corpus in
  which guard and shell must agree in both directions.
- [x] 4.2 Adapter tests: hooks and slash command refused with the reason, MCP still written,
  and hooks still removable by uninstall on an unformattable host.
- [x] 4.3 `printableCommand` tests: quoted, the per-method fallback, and POSIX unaffected.
- [x] 4.4 Windows smoke: run the emitted hook command under the runner's own Git Bash and
  require a version back — the assertion whose absence let #483 ship green.
