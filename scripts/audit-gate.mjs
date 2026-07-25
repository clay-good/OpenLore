#!/usr/bin/env node
/**
 * Dependency audit gate.
 *
 * Wraps `npm audit` so CI can keep gating the FULL tree (prod + dev) at high
 * severity while carrying an explicit, self-expiring exception list. Plain
 * `npm audit --audit-level=high` has no way to say "this one advisory has no
 * reachable fix", so the alternative would be to drop the gate to prod-only
 * and stop catching dev-chain advisories entirely.
 *
 * An entry here is a claim that the advisory has no fix we can apply, not that
 * it does not matter. If an allowlisted advisory disappears from the tree the
 * gate FAILS, so a stale exception cannot outlive its cause.
 */

import { execFileSync } from 'node:child_process';

/** Advisories with no applicable fix. Each needs a reason and a clearing condition. */
const ALLOWLIST = {
  'GHSA-mh99-v99m-4gvg': {
    package: 'brace-expansion',
    reason:
      'Affects <=5.0.7 with its only patch at 5.0.8, so the 1.x line has no fix. ' +
      'Reached solely via eslint -> minimatch@3.1.4, which calls the v1 API ' +
      '(`module.exports = expand`); brace-expansion 5.x exports `{ expand }`, so ' +
      'forcing it breaks lint at runtime. Dev-only, absent from the published files list.',
    clearsWhen: 'eslint raises its minimatch floor past 3.x.',
  },
};

const GATED = new Set(['high', 'critical']);

function runAudit() {
  try {
    // Exits non-zero whenever anything is found; the JSON on stdout is what matters.
    return execFileSync('npm', ['audit', '--json'], {
      encoding: 'utf-8',
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (err) {
    if (err.stdout) return err.stdout;
    throw err;
  }
}

const report = JSON.parse(runAudit());
const vulnerabilities = report.vulnerabilities ?? {};

// Collect root advisories: a `via` entry that is an object is an advisory itself,
// whereas a string entry only names a dependent that inherits one.
const found = new Map(); // ghsaId -> { package, severity, title }
for (const vuln of Object.values(vulnerabilities)) {
  for (const via of vuln.via ?? []) {
    if (typeof via !== 'object' || !GATED.has(via.severity)) continue;
    const id = String(via.url ?? '').split('/').pop();
    if (id) found.set(id, { package: via.name, severity: via.severity, title: via.title });
  }
}

const unexpected = [...found].filter(([id]) => !ALLOWLIST[id]);
const stale = Object.keys(ALLOWLIST).filter(id => !found.has(id));

for (const [id, { package: pkg, severity, title }] of found) {
  if (ALLOWLIST[id]) console.log(`· allowed  ${severity.padEnd(8)} ${pkg}  ${id}\n           ${ALLOWLIST[id].reason}`);
  else console.error(`✖ BLOCKING ${severity.padEnd(8)} ${pkg}  ${id}\n           ${title}`);
}

if (stale.length) {
  console.error(
    `\n✖ Stale audit allowlist entr${stale.length === 1 ? 'y' : 'ies'}: ${stale.join(', ')}\n` +
      `  No longer present in the tree — remove from ALLOWLIST in scripts/audit-gate.mjs.`
  );
}

if (unexpected.length || stale.length) {
  console.error(`\naudit-gate: FAILED (${unexpected.length} unallowed, ${stale.length} stale)`);
  process.exit(1);
}

console.log(`\naudit-gate: OK — no unallowed high/critical advisories.`);
