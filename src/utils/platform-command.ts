import { existsSync } from 'node:fs';
import { win32 } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface PlatformCommand {
  command: string;
  args: string[];
}

export interface PlatformCommandRuntime {
  nodeExecutable?: string;
  npmExecPath?: string;
  pathValue?: string;
  cwd?: string;
  fileExists?: (path: string) => boolean;
  /**
   * Override the resolved OpenLore CLI entry. `null` forces the portable npx form.
   * Distinct from `fileExists`, which exists only to locate the npm CLI on Windows.
   */
  openloreCliEntry?: string | null;
}

const WINDOWS_COMMAND_SHIMS = new Set(['npm', 'npx']);

function isWithinDirectory(path: string, directory: string): boolean {
  const relative = win32.relative(
    win32.resolve(directory).toLowerCase(),
    win32.resolve(path).toLowerCase(),
  );
  return relative === ''
    || (relative !== '..' && !relative.startsWith(`..${win32.sep}`) && !win32.isAbsolute(relative));
}

function resolveNpmCli(
  command: string,
  nodeExecutable: string,
  runtime: PlatformCommandRuntime,
): string {
  const cli = command.toLowerCase() === 'npm' ? 'npm-cli.js' : 'npx-cli.js';
  const candidates: string[] = [];
  const cwd = runtime.cwd ?? process.cwd();
  if (runtime.npmExecPath && win32.isAbsolute(runtime.npmExecPath)) {
    const npmExecCandidate = win32.join(win32.dirname(runtime.npmExecPath), cli);
    if (!isWithinDirectory(npmExecCandidate, cwd)) candidates.push(npmExecCandidate);
  }

  const pathValue = runtime.pathValue ?? (process.platform === 'win32' ? process.env.PATH : '');
  for (const dir of (pathValue ?? '').split(';')) {
    if (!win32.isAbsolute(dir) || isWithinDirectory(dir, cwd)) continue;
    candidates.push(win32.join(dir, 'node_modules', 'npm', 'bin', cli));
  }
  const adjacentCandidate = win32.join(
    win32.dirname(nodeExecutable), 'node_modules', 'npm', 'bin', cli,
  );
  if (!isWithinDirectory(adjacentCandidate, cwd)) candidates.push(adjacentCandidate);

  const fileExists = runtime.fileExists ?? existsSync;
  const resolved = [...new Set(candidates)].find((candidate) => fileExists(candidate));
  if (!resolved) {
    throw new Error(`Could not locate ${cli} in the Windows npm installation`);
  }
  return resolved;
}

/**
 * Return a child-process invocation that can launch Node package-manager shims
 * on the selected platform. Windows `.cmd` files require a shell, so avoid that
 * boundary entirely: run the npm CLI entry point through the already-running,
 * absolute Node executable. Other commands and platforms pass through unchanged.
 */
export function resolvePlatformCommand(
  command: string,
  args: readonly string[] = [],
  platform: NodeJS.Platform = process.platform,
  runtime: PlatformCommandRuntime = {},
): PlatformCommand {
  if (platform === 'win32' && WINDOWS_COMMAND_SHIMS.has(command.toLowerCase())) {
    const nodeExecutable = runtime.nodeExecutable ?? process.execPath;
    if (!win32.isAbsolute(nodeExecutable)) {
      throw new Error(`Windows command resolution requires an absolute Node executable: ${command}`);
    }
    return {
      command: nodeExecutable,
      args: [resolveNpmCli(command, nodeExecutable, runtime), ...args],
    };
  }
  return { command, args: [...args] };
}

/**
 * An argv element no shell treats specially, so it needs no quoting at all.
 *
 * ONE constant for both branches below, deliberately. The Windows branch used to carry its
 * own list of characters that FORCE quoting, and the two rules drifted: the denylist missed
 * `;`, `'`, `~`, `*`, `?`, `#`, brace expansion and the empty string, each of which a POSIX
 * shell acts on in an unquoted word (`a;id` alone runs `id`), while this allowlist was sound
 * from the start. Sharing it means neither branch can be weaker than the other for the same
 * input (change: harden-windows-hook-quoting).
 *
 * Note `:` is IN the list and does not force quoting — a real Windows path is quoted for its
 * separators or its spaces, not for its drive colon.
 *
 * ASCII on purpose: a non-ASCII path like `C:\Users\Müller` is ordinary, and quoting it is
 * cheaper than vouching for every codepoint a shell might one day treat as special.
 */
const SAFE_BARE_WORD = /^[A-Za-z0-9_@%+=:,./-]+$/;

/**
 * Quote one argv element for a POSIX shell.
 *
 * Double quotes are NOT enough here: `$`, a backtick and `\` keep their meaning
 * inside them, so a home directory containing any of those would turn a hook
 * command into a substitution. Single quotes suppress every expansion, and the
 * embedded-quote case closes, escapes, and reopens.
 */
function quotePosix(part: string): string {
  if (SAFE_BARE_WORD.test(part)) return part;
  return `'${part.split("'").join(`'\\''`)}'`;
}

/**
 * Does `$` at this position start a parameter or command substitution, or is it a literal?
 *
 * `[` is in the set for bash's DEPRECATED `$[1+1]` arithmetic, which it still evaluates — a
 * `$` before anything else (a separator, a space, end of string) is an ordinary character, so
 * a profile directory like `C:\Users\dev$` stays writable instead of being refused.
 */
function startsPosixExpansion(next: string | undefined): boolean {
  return next !== undefined && /[A-Za-z0-9_{([*@#?!$-]/.test(next);
}

/**
 * Why the `"<part>"` form cannot carry `part` through a POSIX shell, or `null` when it can.
 *
 * Double quotes do NOT make a POSIX shell literal — inside them a backslash still escapes
 * `$`, a backtick, `"` and another backslash, and `$`/backtick still expand. So the quoted
 * form is right for ordinary Windows paths and WRONG for four shapes, two of which are
 * worse than the bug it fixes:
 *
 *   - an embedded `"` ENDS the quoted run, so the remainder of the line executes as code;
 *   - a TRAILING backslash escapes our own closing quote, swallowing every later argument;
 *   - an unescaped `$…` or backtick is SUBSTITUTED — the very thing `quotePosix` above uses
 *     single quotes to prevent, so the Windows branch must not be weaker for the same input;
 *   - `\$`, `` \` ``, `\"` and `\\` (a UNC prefix, `C:\$Recycle.Bin`) lose the backslash and
 *     mangle the path, which is #483's own `Cannot find module`, one turn at a time.
 *
 * There is no single string that means the same thing to cmd.exe AND to a POSIX shell for
 * those, so this REFUSES rather than emitting a line that silently fails or runs code. The
 * scanner mirrors bash's documented rule and is pinned against a real `bash` in
 * platform-command.posix-oracle.test.ts (change: harden-windows-hook-quoting).
 *
 * NOT covered, deliberately: cmd.exe expands `%VAR%` even inside double quotes and no string
 * form suppresses it. A literal `%` path round-trips under the Git Bash that actually runs
 * our hooks, so refusing it would break a working install to appease a shell we do not target.
 */
export function windowsQuotingHazard(part: string): string | null {
  if (part.includes('\n')) return 'a line break, which a single-line command field cannot carry';
  // The loop below would catch a leading `\\` as an ordinary backslash pair. This case exists
  // only to name it as the UNC path it almost always is, so the message is actionable.
  if (part.startsWith('\\\\')) {
    return 'a UNC prefix (`\\\\server\\share`), whose leading `\\\\` a POSIX shell collapses to one backslash';
  }
  for (let i = 0; i < part.length; i += 1) {
    const char = part[i];
    if (char === '"') {
      return 'a double quote, which would end the quoted run and let the rest of the line run as code';
    }
    if (char === '`') return 'a backtick, which a POSIX shell runs as a command substitution';
    if (char === '$' && startsPosixExpansion(part[i + 1])) {
      return `an expansion (\`${part.slice(i, i + 2)}\`), which a POSIX shell would substitute`;
    }
    if (char === '\\') {
      const next = part[i + 1];
      if (next === undefined) {
        return 'a trailing backslash, which would escape the closing quote and swallow the arguments after it';
      }
      if (next === '$' || next === '`' || next === '"' || next === '\\') {
        return `a \`\\${next}\` pair, whose backslash a POSIX shell drops — mangling the path`;
      }
      i += 1;
    }
  }
  return null;
}

/**
 * The first part of `invocation` that cannot be formatted for Windows, or `null`.
 *
 * Exported for the callers that must NOT take the throw below: an install adapter refuses
 * just the one config field and reports why, and `openlore update` prints its generic
 * instructions, rather than either crashing a whole run over an unwritable path.
 */
export function windowsCommandHazard(
  invocation: PlatformCommand,
): { part: string; reason: string } | null {
  for (const part of [invocation.command, ...invocation.args]) {
    const reason = windowsQuotingHazard(part);
    if (reason) return { part, reason };
  }
  return null;
}

/**
 * Format a resolved fixed-argv invocation for dry-run output and config command fields.
 *
 * The result is a STRING a host runs through a shell (an agent hook command), so the
 * quoting has to match that shell. Since fix-windows-console-flash-from-npx-shim these
 * strings carry absolute filesystem paths on every platform — including the user's home
 * directory — so a path is no longer safely assumed to be free of shell metacharacters.
 *
 * `platform` is REQUIRED, not defaulted: a caller that resolved an invocation FOR another
 * platform must format it for that same platform, and a default silently got that wrong.
 */
export function formatPlatformCommand(
  invocation: PlatformCommand,
  platform: NodeJS.Platform,
): string {
  const parts = [invocation.command, ...invocation.args];
  if (platform !== 'win32') return parts.map(quotePosix).join(' ');
  const hazard = windowsCommandHazard(invocation);
  if (hazard) {
    throw new Error(
      `Cannot write a Windows command for ${hazard.part}: it contains ${hazard.reason}. `
      + 'Reinstall openlore from a path without that character, or wire the command by hand.',
    );
  }
  // Double quotes: the only grouping cmd.exe understands, and the one form that also survives
  // Git Bash, which is the shell Claude Code runs a hook command through on Windows. There a
  // BARE backslash is an escape and is dropped, which is what turned a space-free entry path
  // into `C:Usersme...index.js` and failed every hook with `Cannot find module` (#483).
  //
  // "cmd.exe" here means an interactive prompt, or a `cmd` invocation that wraps the whole line
  // in its own quotes — which is what Node does when it runs a command through a shell. A bare
  // `cmd` with an unwrapped line applies its two-quotes-only rule and would strip our first and
  // last quote; nothing OpenLore writes is run that way, and no string form would survive it.
  return parts
    .map((part) => SAFE_BARE_WORD.test(part) ? part : `"${part}"`)
    .join(' ');
}

/**
 * Does `value` look like OpenLore's own CLI entry point — the path
 * `resolveOpenloreCommand` writes into a host config?
 *
 * Kept beside the emitter on purpose: uninstall identifies a marker-less entry by
 * this shape, and the two must never drift apart.
 */
export function isOpenloreCliEntryPath(value: string): boolean {
  const normalized = value.split('\\').join('/');
  if (!normalized.endsWith('/cli/index.js')) return false;
  // A containing directory has to NAME OpenLore. `node_modules/openlore` covers a real
  // install; the looser substring also matches a checkout or worktree directory, which a
  // strict `=== 'openlore'` segment test missed — found by running a real uninstall from
  // a development worktree, where nothing was removed.
  return normalized.split('/').slice(0, -2).some((segment) => segment.toLowerCase().includes('openlore'));
}

/**
 * npm unpacks `npx` downloads under a `_npx` cache directory it is free to evict.
 * Such a path must never be written into a host config file: it would resolve today
 * and be gone tomorrow. Mirrors the detection `openlore update` already uses.
 */
function isTransientInstall(entryPath: string): boolean {
  const parts = entryPath.split('\\').join('/').split('/');
  return parts.includes('_npx');
}

/**
 * OpenLore's own CLI entry point, or `null` when it must not be wired into a config.
 *
 * `null` covers two cases, both of which fall back to the portable `npx` form:
 * running from TypeScript source (no built sibling), and running out of an npx cache
 * (a path that is deleted behind us).
 */
export function openloreCliEntry(runtime: PlatformCommandRuntime = {}): string | null {
  const override = runtime.openloreCliEntry;
  if (override === null) return null;
  let entry: string;
  if (override !== undefined) {
    // An injected entry is the caller's assertion that the file is there, so it skips the
    // existence probe - but NOT the transience guard, which is about whether the path may
    // be written into a config at all.
    entry = override;
  } else {
    try {
      entry = fileURLToPath(new URL('../cli/index.js', import.meta.url));
    } catch {
      return null;
    }
    if (!existsSync(entry)) return null;
  }
  return isTransientInstall(entry) ? null : entry;
}

/**
 * Resolve an invocation of OpenLore's OWN CLI for a host config file (MCP server
 * entry, agent hook, …).
 *
 * `npx --yes openlore <args>` is portable but wrong on Windows.
 * `resolvePlatformCommand` above removes the shim for `npx` ITSELF, yet npx then
 * launches the TARGET package's bin through its own shim:
 *
 *     cmd.exe /d /s /c openlore orient --inject
 *
 * — a real, visible console window (plus a `conhost.exe`) every time the command
 * runs. For a `UserPromptSubmit` hook that is one window per agent turn, which is
 * what made the app unusable on Windows.
 *
 * `openlore install` IS openlore, so the CLI entry beside this module is the very
 * build the user just invoked. Wire that directly with the absolute Node executable:
 * no shim, no `cmd.exe`, and one process hop fewer on every invocation.
 *
 * TRADE-OFF: this writes an absolute path, so it binds the config to this install
 * location. A global npm install keeps that path across upgrades; a moved or removed
 * install needs `openlore install` re-run, where the `npx` form would have re-fetched.
 * That is the deliberate price of not opening a window on every turn.
 */
export function resolveOpenloreCommand(
  args: readonly string[],
  platform: NodeJS.Platform = process.platform,
  runtime: PlatformCommandRuntime = {},
): PlatformCommand {
  const entry = openloreCliEntry(runtime);
  const nodeExecutable = runtime.nodeExecutable ?? process.execPath;
  // On Windows the Node path is spliced into a config the host spawns without a
  // shell, so it must be absolute — the same precondition resolvePlatformCommand
  // enforces. Anything else falls back rather than emitting an unusable command.
  if (entry && (platform !== 'win32' || win32.isAbsolute(nodeExecutable))) {
    return { command: nodeExecutable, args: [entry, ...args] };
  }
  return resolvePlatformCommand('npx', ['--yes', 'openlore', ...args], platform, runtime);
}
