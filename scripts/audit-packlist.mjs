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
import { readFileSync } from 'node:fs';

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
  // Any test file OUTSIDE `examples/`. The exemption is deliberate and narrow:
  // `examples/` holds self-contained sample repositories (drift-demo, the opencode
  // plugins) whose test files are part of the corpus the demos analyze, so shipping
  // those is the point. Everywhere else — dist, src, stubs, schemas, skills, scripts —
  // a test file means the allowlist widened.
  {
    pattern: /^(?!examples\/).*\.test\.(ts|js|mjs|cjs|tsx|jsx)$/i,
    why: "the package's own test file — excluded by the files allowlist; presence means the allowlist widened",
  },
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
  'dist/api/serve-descriptor.js', // the `openlore/serve-descriptor` subpath (change: extend-api-for-supervising-hosts)
  'scripts/postinstall.mjs', // referenced by the postinstall lifecycle script
  // `skills/` is canonical. Keep one representative old path from each former
  // host-specific catalog so a release cannot silently break direct consumers
  // before they migrate to the canonical location.
  'skills/openlore-generate/SKILL.md',
  'skills/openlore-repair/SKILL.md',
  'examples/opencode-skills/openlore-generate/SKILL.md',
  'examples/mistral-vibe/skills/openlore-generate/SKILL.md',
];

/** High-confidence credential shapes checked inside every textual packed file. */
const CONTENT_SECRETS = [
  { pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/, why: 'private-key block' },
  { pattern: /\bAKIA[0-9A-Z]{16}\b/, why: 'AWS access-key id' },
  { pattern: /\bgh[pousr]_[A-Za-z0-9_]{30,}\b/, why: 'GitHub token' },
  { pattern: /\bnpm_[A-Za-z0-9]{36,}\b/, why: 'npm access token' },
  { pattern: /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{32,}\b/, why: 'provider API key' },
  { pattern: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/, why: 'Slack token' },
];

/**
 * Fails CLOSED, like the audit gate: if the manifest cannot be produced or does not
 * contain a file list, that is reported as "could not verify" rather than passing on
 * an empty list. A check that cannot run must not report success.
 */
function fatal(message, detail = '') {
  console.error(`✖ ${message}`);
  if (detail) console.error(`  ${String(detail).trim().split('\n').slice(0, 6).join('\n  ')}`);
  console.error('\naudit-packlist: FAILED (could not verify the published file list).');
  process.exit(1);
}

function packManifest() {
  let raw;
  try {
    // --dry-run so nothing is written; --json gives the exact file list npm would ship.
    raw = execFileSync('npm', ['pack', '--dry-run', '--json'], {
      encoding: 'utf-8',
      maxBuffer: 64 * 1024 * 1024,
      // npm prints the human-readable tarball summary to stderr; keep it out of stdout.
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    fatal('`npm pack --dry-run --json` failed.', err.stderr || err.message);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    fatal('`npm pack --json` did not return JSON.', raw.slice(0, 400));
  }

  // npm <= 11 returns `[ { files: [...] } ]`; npm >= 12 returns `{ "<pkg>": { files: [...] } }`.
  // Accept both, and never treat an unrecognized shape as "nothing forbidden shipped".
  const entry = Array.isArray(parsed)
    ? parsed[0]
    : (Array.isArray(parsed?.files) ? parsed : Object.values(parsed ?? {})[0]);
  if (!Array.isArray(entry?.files) || entry.files.length === 0) {
    fatal('`npm pack --json` returned no file list — treating as "did not run".');
  }
  return entry.files.map(f => f.path.replace(/\\/g, '/'));
}

const files = packManifest();

const violations = [];
for (const file of files) {
  for (const { pattern, why } of FORBIDDEN) {
    if (pattern.test(file)) violations.push({ file, why });
  }
  let bytes;
  try {
    bytes = readFileSync(file);
  } catch (error) {
    fatal(`Could not read packed file "${file}" for content scanning.`, error.message);
  }
  // Credential formats are textual; avoid decoding native binaries and WASM.
  if (!bytes.includes(0)) {
    const content = bytes.toString('utf-8');
    for (const { pattern, why } of CONTENT_SECRETS) {
      if (pattern.test(content)) violations.push({ file, why });
    }
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
