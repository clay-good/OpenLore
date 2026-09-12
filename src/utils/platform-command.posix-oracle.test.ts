/**
 * Pins the Windows command string against a REAL POSIX shell.
 *
 * #483 was not a logic slip — it was an assumption about a shell nobody asked. The Windows
 * branch was written for cmd.exe, but Claude Code runs a hook command through Git Bash, and
 * every unit test in platform-command.test.ts agreed with the code because both encoded the
 * same wrong assumption. Only an actual shell could have caught it.
 *
 * So this suite does not restate the expected string. It emits the command the installer
 * would write, hands it to `bash`, and asserts the argv that comes back is the argv we meant
 * — the property that was violated on Windows. `bash` is the same shell Git Bash ships, and
 * its double-quote rule is the one being modelled, so a POSIX runner is a faithful oracle
 * for the Windows question (change: harden-windows-hook-quoting).
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { formatPlatformCommand, windowsQuotingHazard } from './platform-command.js';

const NODE_EXE = 'C:\\Program Files\\nodejs\\node.exe';
/** The reporter's own path: an nvm-windows install, which has no space anywhere. */
const NVM_ENTRY =
  'C:\\Users\\me\\AppData\\Roaming\\nvm\\v24.13.0\\node_modules\\openlore\\dist\\cli\\index.js';

function hasBash(): boolean {
  try {
    execFileSync('bash', ['-c', 'exit 0'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
const withBash = hasBash() ? it : it.skip;

/** Every shell probe runs here, never in the repository. See `shellArgv`. */
const SANDBOX = mkdtempSync(join(tmpdir(), 'openlore-posix-oracle-'));
afterAll(() => rmSync(SANDBOX, { recursive: true, force: true }));

/**
 * The argv a POSIX shell produces for `line`, or null when the line is not even parseable.
 *
 * The env is deliberately POPULATED with the variables a hostile path could name, so an
 * expansion that slips through shows up as substituted text rather than as an empty string
 * that might be mistaken for correct quoting. It EXTENDS the parent environment rather than
 * replacing it: on Windows the search path is `Path`, not `PATH`, so a hand-built env is how
 * a test like this stops finding the very `bash` it needs.
 *
 * `cwd` is a THROWAWAY directory, because the hazard under test is a shell escape: a part
 * holding a `"` and a `>` closes the quoted run and REDIRECTS, so probing it from the repo
 * would drop stray files into the working tree. Writing the proof of a shell escape into the
 * project it is defending is not an acceptable way to demonstrate it.
 */
function shellArgv(line: string): string[] | null {
  try {
    const out = execFileSync('bash', ['-c', `printf '%s\\n' ${line}`], {
      encoding: 'utf8',
      cwd: SANDBOX,
      env: { ...process.env, b: 'SUBSTITUTED', IFS: 'SUBSTITUTED', USERNAME: 'SUBSTITUTED' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return out.split('\n').slice(0, -1);
  } catch {
    return null;
  }
}

describe('the emitted Windows command survives a real POSIX shell', () => {
  /**
   * Non-vacuity. Every assertion below is gated on finding a `bash`, so a runner without one
   * would report this file green while proving nothing. CI always has one — the Windows runner
   * gets it from Git for Windows, which is the very shell this suite exists to model — so a
   * missing `bash` there is a broken runner, not a reason to pass quietly.
   */
  it('actually ran against a shell, rather than skipping itself in CI', () => {
    if (!process.env.CI) return;
    expect(hasBash()).toBe(true);
  });

  withBash('delivers the reporter\'s own hook command as the intended argv', () => {
    const invocation = { command: NODE_EXE, args: [NVM_ENTRY, 'orient', '--json'] };
    expect(shellArgv(formatPlatformCommand(invocation, 'win32')))
      .toEqual([NODE_EXE, NVM_ENTRY, 'orient', '--json']);
  });

  withBash('pins #483 itself: the space-only rule left that path bare, and bash ate it', () => {
    // The predicate as it stood before the fix — a space or a cmd.exe metacharacter only.
    const beforeTheFix = [NODE_EXE, NVM_ENTRY, 'orient', '--json']
      .map((part) => /[\s&|<>^%!()]/.test(part) ? `"${part}"` : part)
      .join(' ');
    const argv = shellArgv(beforeTheFix);
    expect(argv).not.toContain(NVM_ENTRY);
    // The reporter's exact symptom: every separator gone, so Node resolved a drive-relative path.
    expect(argv?.[1]).toBe('C:UsersmeAppDataRoamingnvmv24.13.0node_modulesopenloredistcliindex.js');
  });

  withBash.each([
    ['an ordinary install path', 'C:\\npm\\openlore\\dist\\cli\\index.js'],
    ['a path with a space', 'C:\\Program Files\\openlore\\dist\\cli\\index.js'],
    ['a 32-bit Program Files path', 'C:\\Program Files (x86)\\nodejs\\node_modules\\npm\\bin\\npm-cli.js'],
    ['a `$` that starts no expansion', 'C:\\Users\\dev$\\AppData\\Roaming\\npm\\x.js'],
    ['a literal percent', 'C:\\Users\\%USERNAME%\\openlore\\x.js'],
    ['a bang', 'C:\\Users\\a!b\\openlore\\x.js'],
    ['an ampersand', 'C:\\Users\\a&b\\openlore\\x.js'],
    ['a caret', 'C:\\Users\\a^b\\openlore\\x.js'],
    ['parentheses', 'C:\\Users\\a(b)c\\openlore\\x.js'],
    ['a single quote', "C:\\Users\\o'brien\\openlore\\x.js"],
    ['a non-ASCII profile directory', 'C:\\Users\\Müller\\openlore\\x.js'],
    ['a semicolon, which an unquoted word would run as a second command', 'C:\\Users\\a;id\\x.js'],
    ['a tilde, which an unquoted word would expand to a home directory', 'C:\\Users\\~\\x.js'],
    ['a glob, which an unquoted word would match against the directory', 'C:\\Users\\a*b\\x.js'],
  ])('carries %s through unchanged', (_label, entry) => {
    expect(windowsQuotingHazard(entry)).toBeNull();
    expect(shellArgv(formatPlatformCommand({ command: NODE_EXE, args: [entry, 'orient'] }, 'win32')))
      .toEqual([NODE_EXE, entry, 'orient']);
  });

  /**
   * The refusal side of the contract. Every part here is one the quoted form CANNOT carry,
   * and the assertion is that the shell agrees: quoting it anyway either mangles the path or
   * fails to parse. That is what makes the refusal a fact about the shell rather than a
   * matter of taste.
   */
  withBash.each([
    ['an embedded double quote', 'C:\\a"\\openlore\\x.js'],
    ['a trailing backslash', 'C:\\Users\\me\\openlore\\'],
    ['a UNC prefix', '\\\\srv\\share\\openlore\\dist\\cli\\index.js'],
    ['a `\\$` pair', 'C:\\$Recycle.Bin\\openlore\\x.js'],
    ['a parameter expansion', 'C:\\Users\\a$b\\openlore\\x.js'],
    ['a braced expansion', 'C:\\Users\\a${IFS}b\\openlore\\x.js'],
    ['a command substitution', 'C:\\Users\\a$(id)b\\openlore\\x.js'],
    ['a backtick substitution', 'C:\\Users\\a`id`b\\openlore\\x.js'],
    ['bash\'s deprecated $[…] arithmetic', 'C:\\Users\\a$[1+1]b\\openlore\\x.js'],
  ])('refuses %s, and the shell confirms the quoted form is wrong', (_label, entry) => {
    expect(windowsQuotingHazard(entry)).not.toBeNull();
    // What the emitter WOULD have produced if the guard were not there.
    const argv = shellArgv(`"${NODE_EXE}" "${entry}" orient`);
    // Either the line does not parse at all, or the path did not come back intact.
    expect(argv === null || argv[1] !== entry).toBe(true);
  });

  withBash('delivers an empty argument, which the denylist form silently dropped', () => {
    // Not a curiosity: `''` matched nothing in the old must-quote class, so it was emitted
    // bare and disappeared in word splitting — the command ran with one argument fewer.
    expect(shellArgv(formatPlatformCommand({ command: 'N', args: ['a', '', 'b'] }, 'win32')))
      .toEqual(['N', 'a', '', 'b']);
    expect(shellArgv('N a  b')).toEqual(['N', 'a', 'b']);
  });

  withBash('never lets a path smuggle a second command past the quoting', () => {
    const injected = 'C:\\a" && echo PWNED && echo "\\x.js';
    // First, the hazard is real, not theoretical: an embedded `"` closes the quote and
    // leaves `&&` at the top level, so the shell RUNS the smuggled command. This asserts
    // the shell actually executed it — the reason the guard cannot be softened to a warning.
    expect(shellArgv(`"${NODE_EXE}" "${injected}"`)).toContain('PWNED');
    // The emitter therefore refuses the part outright instead of writing that line.
    expect(() => formatPlatformCommand({ command: NODE_EXE, args: [injected] }, 'win32'))
      .toThrow(/double quote/);
  });

  withBash('delivers every part it accepts, over a hostile corpus', () => {
    // This drives the REAL emitter, not a hand-written `"${part}"`. That distinction matters:
    // a part the emitter leaves BARE is exposed to a different set of metacharacters than a
    // quoted one (`a;id` alone runs `id`), and an earlier version of this test compared the
    // guard against the quoted form only — so it could not see the bare branch at all.
    //
    // A failure in either direction is a bug:
    //   accepted but not delivered -> we would write a broken or dangerous command
    //   refused but deliverable    -> we would refuse a working install
    // `[` is in the alphabet deliberately: bash still evaluates the deprecated `$[1+1]`
    // arithmetic, and an alphabet without it let that expansion class pass unnoticed.
    const alphabet = ['a', 'B', '1', '\\', '$', '`', '"', '{', '}', '(', ')', '[', ']', ' ', '!', '%', '^', '&', '|', '<', '>', '-', '_', '*', '@', '#', '?', ':', '.', '/', "'", ';', '~', '+', '=', ','];
    const disagreements: Array<{ part: string; accepted: boolean; delivered: boolean }> = [];
    let seed = 20260912;
    const next = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    // Each case is one `bash` spawn. A Windows runner creates processes far more slowly than
    // a POSIX one and sits closer to the suite timeout, so it takes a smaller sample of the
    // same property — bash's grammar does not vary by host.
    const cases = process.platform === 'win32' ? 200 : 900;
    for (let i = 0; i < cases; i += 1) {
      const length = 1 + Math.floor(next() * 6);
      const part = Array.from({ length }, () => alphabet[Math.floor(next() * alphabet.length)]).join('');
      const accepted = windowsQuotingHazard(part) === null;
      const delivered = accepted
        ? shellArgv(formatPlatformCommand({ command: 'N', args: [part] }, 'win32'))?.[1] === part
        : shellArgv(`"${part}"`)?.[0] === part;
      if (accepted !== delivered) disagreements.push({ part, accepted, delivered });
    }
    expect(disagreements).toEqual([]);
  }, 60_000);

  withBash('confines a shell escape that writes files to the throwaway directory', () => {
    // Not incidental: this probe is CHOSEN to break out of its quoting and redirect, because
    // the corpus above can do the same by chance. Writing that file into the repository is
    // how this suite was first caught littering the working tree, so containment is asserted
    // rather than assumed — in the sandbox, and nowhere near the project.
    const escaping = 'x" > escaped-here.txt; echo "y';
    shellArgv(`"${escaping}"`);
    expect(readdirSync(SANDBOX)).toContain('escaped-here.txt');
    expect(existsSync(join(process.cwd(), 'escaped-here.txt'))).toBe(false);
  });
});
