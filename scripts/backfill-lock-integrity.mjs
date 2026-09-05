#!/usr/bin/env node
/**
 * Backfill SRI digests that npm omits from package-lock.json.
 *
 * A dependency that ships its own npm-shrinkwrap.json can pin nested tarballs
 * without an `integrity` field. npm copies those entries verbatim, so a freshly
 * regenerated lockfile silently loses the digests `npm ci` needs to verify the
 * bytes it downloads. This script refills them from the registry and proves each
 * digest against the tarball it names before writing it.
 *
 * Usage: node scripts/backfill-lock-integrity.mjs [--check]
 *   --check  exit non-zero if any digest is missing, without writing.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const LOCK = new URL('../package-lock.json', import.meta.url);
const REGISTRY = 'https://registry.npmjs.org/';
const checkOnly = process.argv.includes('--check');

const lock = JSON.parse(await readFile(LOCK, 'utf8'));
const gaps = Object.entries(lock.packages ?? {}).filter(
  ([, pkg]) => pkg.resolved?.startsWith(REGISTRY) && !pkg.integrity,
);

if (gaps.length === 0) {
  console.log('lock-integrity: every registry tarball already carries an SRI digest.');
  process.exit(0);
}

if (checkOnly) {
  console.error(`lock-integrity: ${gaps.length} entries missing an SRI digest:`);
  for (const [path] of gaps) console.error(`  ${path}`);
  process.exit(1);
}

for (const [path, pkg] of gaps) {
  const tarball = await fetch(pkg.resolved);
  if (!tarball.ok) throw new Error(`${path}: cannot fetch ${pkg.resolved} (${tarball.status})`);
  const bytes = Buffer.from(await tarball.arrayBuffer());
  const digest = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;

  // The registry's own metadata must agree with the bytes we just hashed;
  // a mismatch means the tarball is not what the registry says it is.
  const name = path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length);
  const meta = await fetch(new URL(`${encodeURIComponent(name)}/${encodeURIComponent(pkg.version)}`, REGISTRY));
  if (!meta.ok) throw new Error(`${path}: cannot fetch metadata for ${name}@${pkg.version}`);
  const published = (await meta.json())?.dist?.integrity;
  if (published && published !== digest) {
    throw new Error(`${path}: tarball digest ${digest} does not match published ${published}`);
  }

  pkg.integrity = digest;
  console.log(`lock-integrity: ${path} -> ${digest.slice(0, 24)}…`);
}

await writeFile(LOCK, `${JSON.stringify(lock, null, 2)}\n`);
console.log(`lock-integrity: backfilled ${gaps.length} digests.`);
