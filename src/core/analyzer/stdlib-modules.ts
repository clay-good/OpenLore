/**
 * Standard-library and builtin module recognition (change: add-phantom-reference-findings).
 *
 * A reference check that reported every `import os` as an undeclared dependency would be useless,
 * so each ecosystem gets a CLOSED rule for "this name is the language's own, not a package":
 *
 *   - **npm** — the Node runtime's own `module.builtinModules`, plus the `node:` scheme. Taken from
 *     the runtime rather than hand-listed, so it cannot drift from reality.
 *   - **Go** — the canonical language rule, not a list: a module path's first element must contain a
 *     dot (`github.com/x/y`), so an import path whose first element has none (`fmt`, `net/http`) is
 *     standard library. This is exactly how the go tool tells them apart.
 *   - **Rust** — the crate roots the compiler provides (`std`, `core`, `alloc`, …) and the path
 *     keywords that stay inside the current crate.
 *   - **Python** — a list, because the language offers no rule. Top-level module names of the CPython
 *     standard library (3.8 through 3.13, including the ones removed in 3.13, so a repository on an
 *     older runtime is not mis-reported).
 *
 * A language whose ecosystem is not listed here is not assessed for undeclared dependencies at all:
 * calling an unknown import "undeclared" would be a guess, and this file is the allow list that
 * makes the claim safe (`AddedReferencesResolveOrAreReported`).
 */

import { builtinModules } from 'node:module';

import type { PackageEcosystem } from './external-packages.js';

/**
 * The ecosystems whose manifests and standard libraries are recognized. Same vocabulary as the
 * manifest reader's {@link PackageEcosystem}, so one name means one thing throughout.
 */
export type Ecosystem = PackageEcosystem;

/** Node's own builtin module names, as the running runtime reports them. */
export const NODE_BUILTINS: ReadonlySet<string> = new Set(builtinModules.filter(m => !m.startsWith('_')));

/** Crate roots the Rust compiler provides, and the path keywords that stay in the current crate. */
export const RUST_BUILTIN_CRATES: ReadonlySet<string> = new Set([
  'std', 'core', 'alloc', 'proc_macro', 'test',
  'crate', 'self', 'super',
]);

/**
 * Top-level module names of the CPython standard library. Kept deliberately wide across versions:
 * a name that was standard library in any supported version must never read as a package.
 */
export const PYTHON_STDLIB: ReadonlySet<string> = new Set([
  '__future__', '_thread', 'abc', 'aifc', 'argparse', 'array', 'ast', 'asynchat', 'asyncio',
  'asyncore', 'atexit', 'audioop', 'base64', 'bdb', 'binascii', 'bisect', 'builtins', 'bz2',
  'calendar', 'cgi', 'cgitb', 'chunk', 'cmath', 'cmd', 'code', 'codecs', 'codeop', 'collections',
  'colorsys', 'compileall', 'concurrent', 'configparser', 'contextlib', 'contextvars', 'copy',
  'copyreg', 'crypt', 'csv', 'ctypes', 'curses', 'dataclasses', 'datetime', 'dbm', 'decimal',
  'difflib', 'dis', 'distutils', 'doctest', 'email', 'encodings', 'ensurepip', 'enum', 'errno',
  'faulthandler', 'fcntl', 'filecmp', 'fileinput', 'fnmatch', 'fractions', 'ftplib', 'functools',
  'gc', 'getopt', 'getpass', 'gettext', 'glob', 'graphlib', 'grp', 'gzip', 'hashlib', 'heapq',
  'hmac', 'html', 'http', 'imaplib', 'imghdr', 'imp', 'importlib', 'inspect', 'io', 'ipaddress',
  'itertools', 'json', 'keyword', 'lib2to3', 'linecache', 'locale', 'logging', 'lzma', 'mailbox',
  'mailcap', 'marshal', 'math', 'mimetypes', 'mmap', 'modulefinder', 'msilib', 'msvcrt',
  'multiprocessing', 'netrc', 'nis', 'nntplib', 'numbers', 'operator', 'optparse', 'os', 'ossaudiodev',
  'pathlib', 'pdb', 'pickle', 'pickletools', 'pipes', 'pkgutil', 'platform', 'plistlib', 'poplib',
  'posix', 'pprint', 'profile', 'pstats', 'pty', 'pwd', 'py_compile', 'pyclbr', 'pydoc', 'queue',
  'quopri', 'random', 're', 'readline', 'reprlib', 'resource', 'rlcompleter', 'runpy', 'sched',
  'secrets', 'select', 'selectors', 'shelve', 'shlex', 'shutil', 'signal', 'site', 'smtplib',
  'sndhdr', 'socket', 'socketserver', 'spwd', 'sqlite3', 'sre_compile', 'sre_constants', 'sre_parse',
  'ssl', 'stat', 'statistics', 'string', 'stringprep', 'struct', 'subprocess', 'sunau', 'symtable',
  'sys', 'sysconfig', 'syslog', 'tabnanny', 'tarfile', 'telnetlib', 'tempfile', 'termios', 'test',
  'textwrap', 'threading', 'time', 'timeit', 'tkinter', 'token', 'tokenize', 'tomllib', 'trace',
  'traceback', 'tracemalloc', 'tty', 'turtle', 'turtledemo', 'types', 'typing', 'unicodedata',
  'unittest', 'urllib', 'uu', 'uuid', 'venv', 'warnings', 'wave', 'weakref', 'webbrowser', 'winreg',
  'winsound', 'wsgiref', 'xdrlib', 'xml', 'xmlrpc', 'zipapp', 'zipfile', 'zipimport', 'zlib',
  'zoneinfo',
]);

/**
 * The package (or module) name a specifier belongs to, as a manifest would declare it; null when the
 * specifier names no package — it is standard library, a builtin, or relative.
 *
 * `@scope/pkg/sub` → `@scope/pkg`, `lodash/fp` → `lodash`, `github.com/x/y/z` → the module path
 * prefix cannot be known from the specifier alone, so the whole path is returned and matched by
 * prefix against the declared modules.
 */
export function packageNameOf(ecosystem: Ecosystem, specifier: string): string | null {
  if (isStdlibSpecifier(ecosystem, specifier)) return null;
  if (isRelativeSpecifier(specifier)) return null;
  switch (ecosystem) {
    case 'npm': {
      const parts = specifier.split('/');
      return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
    }
    case 'pypi':
      // `from a.b import c` is declared as the distribution that provides the top-level package.
      return specifier.split('.')[0];
    case 'go':
      // A full import path; the declaring module is a prefix of it (matched by the caller).
      return specifier;
    case 'cargo':
      // Cargo declares crate names with dashes; `use` paths spell them with underscores.
      return specifier.split('::')[0];
  }
}

/** Whether a specifier is a path relative to the importing file (never a package). */
export function isRelativeSpecifier(specifier: string): boolean {
  return specifier.startsWith('.') || specifier.startsWith('/');
}

/** Whether a specifier names the language's own standard library or a runtime builtin. */
export function isStdlibSpecifier(ecosystem: Ecosystem, specifier: string): boolean {
  if (specifier === '') return true; // nothing to resolve
  switch (ecosystem) {
    case 'npm': {
      if (specifier.startsWith('node:') || specifier.startsWith('bun:')) return true;
      const top = specifier.startsWith('@') ? specifier : specifier.split('/')[0];
      return NODE_BUILTINS.has(top);
    }
    case 'pypi':
      return PYTHON_STDLIB.has(specifier.split('.')[0]);
    case 'go': {
      // The canonical rule: a module path's first element contains a dot. `fmt`, `net/http` do not.
      const first = specifier.split('/')[0];
      return !first.includes('.') && !first.includes(':');
    }
    case 'cargo':
      return RUST_BUILTIN_CRATES.has(specifier.split('::')[0]);
  }
}

/** The ecosystem a source file's language belongs to; null when none is recognized. */
export function ecosystemOfLanguage(language: string): Ecosystem | null {
  switch (language.toLowerCase()) {
    case 'typescript':
    case 'javascript':
    case 'tsx':
    case 'jsx':
      return 'npm';
    case 'python':
      return 'pypi';
    case 'go':
      return 'go';
    case 'rust':
      return 'cargo';
    default:
      return null;
  }
}
