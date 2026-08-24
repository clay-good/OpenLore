#!/usr/bin/env node
/**
 * Update the Homebrew formula to point at a published npm release.
 *
 * Fetches the npm registry tarball for the given version, computes its sha256
 * (what Homebrew pins on), and rewrites the `url` + `sha256` lines of
 * packaging/homebrew/openlore.rb. The rest of the formula (desc, deps, install,
 * test) is preserved, so hand-edits there survive a bump.
 *
 * Run manually after publishing:
 *   node scripts/update-homebrew-formula.mjs            (uses package.json version, edits in place)
 *   node scripts/update-homebrew-formula.mjs --version 3.0.0
 *
 * The formula is staged for a future homebrew-core submission and is not updated
 * by the npm release workflow.
 *
 * Flags:
 *   --version <x.y.z>   version to pin (default: package.json version; a leading "v" is stripped)
 *   --formula <path>    formula to read/rewrite (default: packaging/homebrew/openlore.rb)
 *   --out <path>        where to write the result (default: in place over --formula)
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const pkgVersion = JSON.parse(readFileSync('package.json', 'utf8')).version;
const version = String(arg('--version', pkgVersion)).replace(/^v/, '');
const formulaPath = arg('--formula', 'packaging/homebrew/openlore.rb');
const outPath = arg('--out', formulaPath);
const url = `https://registry.npmjs.org/openlore/-/openlore-${version}.tgz`;

/** sha256 of the registry tarball, retrying for registry propagation right after publish. */
async function sha256OfTarball(tarballUrl) {
  let lastErr;
  for (let attempt = 1; attempt <= 6; attempt++) {
    try {
      const res = await fetch(tarballUrl);
      if (res.ok) {
        const buf = Buffer.from(await res.arrayBuffer());
        return createHash('sha256').update(buf).digest('hex');
      }
      lastErr = new Error(`HTTP ${res.status} for ${tarballUrl}`);
    } catch (err) {
      lastErr = err;
    }
    if (attempt < 6) {
      const waitMs = 3000 * attempt;
      console.error(`  tarball not ready (attempt ${attempt}); retrying in ${waitMs}ms…`);
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
  throw new Error(`Could not fetch ${tarballUrl}: ${lastErr?.message ?? 'unknown error'}`);
}

const sha256 = await sha256OfTarball(url);

let formula = readFileSync(formulaPath, 'utf8');
const before = formula;
formula = formula
  .replace(/^(\s*)url ".*"$/m, `$1url "${url}"`)
  .replace(/^(\s*)sha256 ".*"$/m, `$1sha256 "${sha256}"`);

if (!/^\s*url ".*"$/m.test(formula) || !/^\s*sha256 ".*"$/m.test(formula)) {
  throw new Error(`Formula ${formulaPath} is missing a url/sha256 line to update.`);
}
if (formula === before && outPath === formulaPath) {
  console.log(`Formula already pinned to v${version} (${sha256}).`);
} else {
  writeFileSync(outPath, formula);
}

console.log(`openlore Homebrew formula → v${version}`);
console.log(`  url    ${url}`);
console.log(`  sha256 ${sha256}`);
console.log(`  wrote  ${outPath}`);
