## Why

`openlore install` wrote a Windows hook command whose entry path was not quoted, so every
`SessionStart` and `UserPromptSubmit` fired `Cannot find module` (#483, fixed by #484 from
@L4XB). The rule quoted a part only when it held a space or a cmd.exe metacharacter:

```ts
.map((part) => /[\s&|<>^%!()]/.test(part) ? `"${part}"` : part)
```

`C:\Program Files\nodejs\node.exe` was quoted because it has a space. An nvm-windows entry
path has none, so it went through bare — and Claude Code runs a hook through **Git Bash**,
where a bare `\` is an escape that is dropped. The reporter's path arrived as
`C:UsersmeAppDataRoamingnvm...index.js`.

The defect was not the regex. It was that the Windows branch was written for cmd.exe and
never asked the shell that actually runs the string, and every unit test agreed with the code
because both encoded the same assumption. Only a real shell could have caught it.

Asking one (`bash`, the shell Git Bash ships) shows the fix is right for ordinary paths and
that **double quotes do not make a POSIX shell literal**. Inside them a backslash still
escapes `$`, a backtick, `"` and another backslash, and `$`/backtick still expand. Four
shapes therefore remain wrong, two of them worse than the bug #484 fixes:

| Part | Emitted `"…"` becomes | Consequence |
|---|---|---|
| `C:\a"\x.js` | quote closes early | **the rest of the line runs as code** |
| `C:\Users\me\` | trailing `\` escapes our own `"` | **swallows every later argument** |
| `C:\Users\a$b\x.js` | `$b` substituted | wrong path, silently |
| `\\srv\share\…`, `C:\$Recycle.Bin\…` | `\\` / `\$` lose a backslash | #483's own error, one turn at a time |

## What Changes

**#484's outcome is kept, and its mechanism is inverted.** Quoting the entry path is right
for cmd.exe, Git Bash and PowerShell, and it is what users need today. But #484 gets there by
adding `\` to a DENYLIST, and a denylist is only ever as complete as the next character
someone thinks of: over 900 random parts, 84 that the denylist emitted BARE came back mangled
or dangerous, because an unquoted word exposes a different set of metacharacters — `;`, `'`,
`~`, `*`, `?`, `#`, brace expansion, the empty string. `a;id` alone runs `id`.

The POSIX branch never had this problem: `quotePosix` is an ALLOWLIST and single-quotes
everything else, sound by construction. The Windows branch now matches it — quote unless the
part is only characters no shell treats specially. Same result for every real path (all
contain `\`, `:` or a space), same readable bare `orient --json`, and the bare branch stops
being a second, unmodelled quoting rule.

**The four unrepresentable shapes are REFUSED, not emitted.** No single string means the same
thing to cmd.exe and to a POSIX shell for them, so `formatPlatformCommand` throws instead of
writing a line that silently fails or executes code — the protection `quotePosix` already
gives the POSIX branch, which the Windows branch was missing for the same input.

**The refusal reaches the user as a refusal, not a crash.** `runInstall` rethrows a
project-scope adapter error, so both config writers check first (`windowsCommandHazard`) and
decline one file with the reason. `openlore update` only ever PRINTS a command — it spawns its
own argv without a shell — so it degrades to the plain package-manager instruction for the
detected method. That instruction is derived from the method, not from the resolved
invocation: joining the resolved parts would have printed two unquoted absolute paths, which
is less runnable than the line it replaces.

**Uninstall is decoupled from formatting.** `managedHooks` was called on the removal path for
its keys alone, so an unformattable path would have thrown there too — stranding the hooks
uninstall exists to remove. The keys are now a constant.

**A real Windows host checks the real hook.** The Windows smoke job already asserted the wired
MCP launcher executes, but never ran the hook STRING through a shell — which is exactly how
#483 shipped green. It now writes the hook command to a script, runs it under the runner's own
Git Bash, and requires a version back, so the reporter's failure cannot return unnoticed.

**A real shell is the oracle.** `platform-command.posix-oracle.test.ts` emits the command the
installer would write, hands it to `bash`, and asserts the argv that comes back is the argv we
meant. It pins #483 itself (the old predicate, and the reporter's exact mangled path), proves
the injection case executes when unguarded, and drives the EMITTER over a hostile corpus so
guard and shell cannot drift. The corpus goes through `formatPlatformCommand`, not a
hand-written `"…"`: comparing against the quoted form only is what hid the bare branch, and
the same corpus reports 84 failures against the denylist emitter and none against the
allowlist. Its probes run in a throwaway directory, because a part that escapes its quoting
redirects — which first surfaced as stray files in this repo's own working tree.

## Deliberately NOT done

- **The hook string is not switched to POSIX single quotes**, which would carry all four
  shapes perfectly. Evidence says Git Bash runs our hooks, but a single-quoted line is
  meaningless to cmd.exe, so being wrong about that would break every working Windows install
  to fix a shape almost nobody has. The double-quote form stays; the unrepresentable rest is
  refused.
- **No forward-slash normalization.** It rescues UNC and a trailing separator, but not `$`
  (`"C:/$Recycle.Bin/x"` still expands), so it would trade one silent mangling for another
  while changing the emitted path for every Windows user.
- **cmd.exe's `%VAR%` expansion is not defended.** No string form suppresses it, and a literal
  `%` path round-trips under the Git Bash that actually runs our hooks — refusing it would
  break a working install to appease a shell we do not target. Disclosed at the code.
- **No new spec domain.** One `cli` requirement, mirroring `SubprocessesNeverSurfaceAConsoleWindow`.
