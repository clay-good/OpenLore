## ADDED Requirements

### Requirement: WiredCommandStringsRoundTripThroughTheShellThatRunsThem

A command string OpenLore writes into a host config file SHALL be quoted for the shell that
will run it, and SHALL be refused when no quoting form can carry it.

On Windows that shell is not cmd.exe. Claude Code runs a hook command through Git Bash, where
a bare `\` is an escape: a path quoted only when it contains a space left every space-free
entry path bare, and Git Bash dropped every separator, so each hook invocation failed to
resolve the module (#483).

A part SHALL be quoted unless it consists only of characters no shell treats specially. The
rule SHALL be an allowlist rather than a list of characters that force quoting: an unquoted
word is exposed to `;`, `'`, `~`, `*`, `?`, `#`, brace expansion and the empty string, so a
denylist leaves a second, unmodelled quoting rule on the bare branch — `a;id` emitted bare
runs `id`. The POSIX branch is already allowlist-shaped, and the two SHALL NOT differ in
soundness for the same input.

Double quotes are the form both shells accept, but they do NOT make a POSIX shell literal —
inside them a backslash still escapes `` $ ` " \ `` and newline, and `$`/backtick still expand.
A part containing an embedded `"`, a trailing backslash, an unescaped expansion or backtick, or
a backslash pair (a UNC prefix, `C:\$Recycle.Bin`) therefore cannot be represented for both
shells at once. Such a part SHALL be refused rather than emitted: an embedded `"` ends the
quoted run and lets the remainder of the line execute, and a trailing backslash escapes the
closing quote and swallows the arguments after it, so emitting either is worse than the bug
that motivated quoting.

Such a host SHALL still receive every part of the install that does NOT depend on a shell
string — the MCP server entry, which is an argv; the instruction block; the tool permission —
and SHALL lose only the hooks, named with the reason. It SHALL NOT be reported as a conflict:
an unquotable path is a property of the host rather than a clash with the user's file, and
conflict semantics fail the run, which also skips the index build.

A hook OpenLore wired earlier SHALL be REMOVED on such a host rather than left in place, since
it names a command the host mangles and would fail on every invocation; entries the user
authored in the same hook group SHALL survive.

A command that is only DISPLAYED — `openlore update` prints an upgrade line and executes its
own argv without a shell — SHALL print a command the user can actually run. On Windows that is
the plain package-manager instruction, not the resolved invocation: a statement whose first
token is a quoted path parses in PowerShell as a string expression rather than a command.

The removal path SHALL NOT format a command at all, so that a host whose paths became
unformattable can still uninstall what was wired.

The guard SHALL be pinned against a REAL POSIX shell rather than against a restated expected
string: the emitted line is handed to `bash` and the argv it yields is compared to the intended
argv. A test that asserts the emitter's output matches the emitter's own assumption about a
shell cannot fail when that assumption is wrong, which is precisely how #483 shipped green.

#### Scenario: A space-free Windows entry path is wired

- **GIVEN** an nvm-windows install, whose CLI entry path contains no space
- **WHEN** the hook command is formatted for `win32`
- **THEN** the entry path is double-quoted, and a POSIX shell reproduces it separator-for-separator

#### Scenario: A path the quoted form cannot carry

- **GIVEN** a host whose profile directory is a shell expansion (`C:\Users\a$b`)
- **WHEN** `openlore install` runs
- **THEN** the hooks file and the Continue config are declined, each naming the offending part and
  why, the MCP entry (an argv, never a shell string) is still written, and the run does not crash

#### Scenario: Uninstalling from a host that can no longer be formatted

- **GIVEN** hooks wired earlier, on a host whose paths are now unformattable
- **WHEN** `openlore install --uninstall` runs
- **THEN** the marker-identified hook groups are removed, because removal needs the keys only
