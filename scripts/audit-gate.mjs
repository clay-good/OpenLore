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
const ALLOWLIST = {};

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

/**
 * Fail CLOSED when the audit did not actually run.
 *
 * `npm audit` exits non-zero both when it finds advisories AND when it cannot run at
 * all (no lockfile, registry unreachable, an output-shape change). Those look alike
 * from the outside, so the report has to be validated rather than trusted: a missing
 * `vulnerabilities` map would otherwise read as "nothing found" and the gate would
 * report OK without having checked anything.
 */
function parseReport(raw) {
  let report;
  try {
    report = JSON.parse(raw);
  } catch {
    fatal('npm audit did not return JSON.', raw.slice(0, 400));
  }
  if (report.error) {
    fatal(
      `npm audit could not run: ${report.error.code ?? 'unknown error'}.`,
      report.error.summary ?? report.error.detail ?? ''
    );
  }
  // Both keys are present on every successful `npm audit --json`, including a clean
  // tree (where `vulnerabilities` is an empty object). Absence means "did not run".
  if (typeof report.vulnerabilities !== 'object' || report.vulnerabilities === null) {
    fatal('npm audit returned no `vulnerabilities` map — treating as "did not run".');
  }
  if (typeof report.metadata !== 'object' || report.metadata === null) {
    fatal('npm audit returned no `metadata` block — treating as "did not run".');
  }
  return report;
}

function fatal(message, detail = '') {
  console.error(`✖ ${message}`);
  if (detail) console.error(`  ${String(detail).trim().split('\n').join('\n  ')}`);
  console.error(
    '\naudit-gate: FAILED (could not verify the dependency tree).\n' +
      'This is deliberate — a gate that cannot run must not report success. ' +
      'Fix the underlying npm error and re-run.'
  );
  process.exit(1);
}

const report = parseReport(runAudit());
const vulnerabilities = report.vulnerabilities;

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
