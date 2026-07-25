#!/usr/bin/env node
/**
 * Published-tarball content guard.
 *
 * Publishing is the one step that cannot be taken back — an accidentally shipped
 * `.env`, a local `.openlore/` index, or an SSH key is public the moment `npm
 * publish` returns, and unpublishing is heavily restricted.
 *
 * `package.json` `files` is an allowlist, so this is not a likely accident today.
 * It is a *cheap* one though: widening `files` (adding a directory, or a broad glob
 * like `src`) is a one-line diff that looks harmless in review and silently changes
 * what ships. This asserts against the real `npm pack` manifest, so it sees exactly
 * what npm would upload — including anything pulled in by `files`, `main`, `bin`,
 * or npm's always-included set.
 *
 * Checks both directions: nothing forbidden ships, AND the entrypoints do. A `files`
 * typo that silently publishes a package with no `dist/` is also a broken release.
 */

import { execFileSync } from 'node:child_process';

/** Anything matching these must never ship. */
const FORBIDDEN = [
  { pattern: /(^|\/)\.env($|\.|\/)/i, why: 'environment file — may contain provider API keys' },
  { pattern: /(^|\/)\.openlore\//i, why: 'local analysis index — contains absolute paths from the author machine' },
  { pattern: /(^|\/)\.git\//i, why: 'git internals' },
  { pattern: /(^|\/)node_modules\//i, why: 'vendored dependency tree' },
  { pattern: /(^|\/)\.npmrc$/i, why: 'npm config — may contain a registry auth token' },
  { pattern: /(^|\/)(id_rsa|id_ed25519|.*\.pem|.*\.p12|.*\.pfx|.*\.key)$/i, why: 'private key material' },
  { pattern: /(^|\/)\.aws\//i, why: 'cloud credentials' },
  { pattern: /(^|\/)\.ssh\//i, why: 'SSH material' },
  // Scoped to the package's OWN code. `examples/` is deliberately exempt: those
  // directories are self-contained sample repositories (drift-demo, the opencode
  // plugins) whose test files are part of the corpus the demos analyze — shipping
  // them is the point, not a leak.
  { pattern: /^(dist|src)\/.*\.test\.(ts|js|mjs|cjs|tsx|jsx)$/i, why: "the package's own test file — excluded by the files allowlist; presence means the allowlist widened" },
  { pattern: /(^|\/)coverage\//i, why: 'coverage report' },
  { pattern: /(^|\/)\.claude\//i, why: 'local agent configuration' },
];

/** Must be present, or the published package is broken. */
const REQUIRED = [
  'package.json',
  'README.md',
  'LICENSE',
  'dist/cli/index.js', // the `openlore` bin
  'dist/api/index.js', // the library entrypoint
  'scripts/postinstall.mjs', // referenced by the postinstall lifecycle script
];

function packManifest() {
  // --dry-run so nothing is written; --json gives the exact file list npm would ship.
  const raw = execFileSync('npm', ['pack', '--dry-run', '--json'], {
    encoding: 'utf-8',
    maxBuffer: 64 * 1024 * 1024,
    // npm prints the human-readable tarball summary to stderr; keep it out of stdout.
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const parsed = JSON.parse(raw);
  const entry = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!entry?.files) throw new Error('npm pack --json returned no file list');
  return entry.files.map(f => f.path.replace(/\\/g, '/'));
}

const files = packManifest();

const violations = [];
for (const file of files) {
  for (const { pattern, why } of FORBIDDEN) {
    if (pattern.test(file)) violations.push({ file, why });
  }
}

const missing = REQUIRED.filter(req => !files.includes(req));

console.log(`packlist: ${files.length} files would be published.`);

for (const { file, why } of violations) {
  console.error(`✖ FORBIDDEN  ${file}\n             ${why}`);
}
for (const req of missing) {
  console.error(`✖ MISSING    ${req}\n             required entrypoint absent — check the "files" allowlist and that the build ran`);
}

if (violations.length || missing.length) {
  console.error(
    `\naudit-packlist: FAILED (${violations.length} forbidden, ${missing.length} missing)\n` +
      `Adjust "files" in package.json, or update the lists in scripts/audit-packlist.mjs if the change is intended.`
  );
  process.exit(1);
}

console.log('audit-packlist: OK — nothing forbidden, all entrypoints present.');
