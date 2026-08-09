/**
 * Every outbound HTTPS request must go through `withRelaxedTls`.
 *
 * WHY THIS IS A TEST AND NOT A CONVENTION
 * When TLS relaxation moved from "set an env var once at start-up" to "relax around
 * each request", the set of `fetch` calls that needed wrapping became something a
 * person has to remember. That failed twice while writing the change itself:
 * `doctor.ts` opted in and never wrapped (so its probe would have started FAILING for
 * exactly the users who configured `skipSslVerify`), and `view.ts`'s model listing
 * silently lost the relaxation it used to inherit from the global variable.
 *
 * Neither broke a test, because nothing in the suite probes a self-signed endpoint
 * through those paths. A reviewer would have had to notice an absence. So the rule is
 * enforced here instead: add an https-capable `fetch` without wrapping it, and this
 * fails with the file and line.
 *
 * The failure mode being prevented is quiet and one-directional — the request simply
 * starts rejecting certificates the user chose to accept, in a code path most CI
 * never exercises.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SRC = join(REPO_ROOT, 'src');

/**
 * Calls that cannot involve TLS, with the reason each is exempt.
 *
 * Only loopback HTTP to OpenLore's own daemon qualifies: `serve-client` builds
 * `http://<host>:<port>` from the serve descriptor, and the Pi extension talks to
 * that same daemon. There is no certificate to verify, so wrapping would be noise.
 *
 * `pi/extension.ts` `fetchModels` is listed for a different reason and is NOT an
 * endorsement: the Pi host never calls `allowInsecureTls`, so its provider probe has
 * never honoured `skipSslVerify` — before or after the scoping change. Wrapping it
 * alone would change nothing; making it work needs the Pi host to read the config and
 * opt in, which is a behaviour change in its own right.
 */
const EXEMPT: { file: string; line: number; why: string }[] = [
  { file: 'src/core/services/serve-client.ts', line: 90, why: 'loopback http:// health probe' },
  { file: 'src/core/services/serve-client.ts', line: 163, why: 'loopback http:// daemon call' },
  { file: 'src/cli/commands/serve.ts', line: 210, why: 'loopback http:// health and compatibility probe' },
  { file: 'src/cli/commands/serve.ts', line: 250, why: 'loopback http:// authenticated shutdown request' },
  { file: 'src/pi/extension.ts', line: 447, why: 'loopback http:// health probe' },
  { file: 'src/pi/extension.ts', line: 545, why: 'loopback http:// daemon call' },
  { file: 'src/pi/extension.ts', line: 1318, why: 'loopback http:// health probe' },
  {
    file: 'src/pi/extension.ts',
    line: 178,
    why: 'pre-existing: the Pi host never opts in, so skipSslVerify is not honoured there at all',
  },
];

function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === 'fixtures' || name === 'vendor' || name === 'node_modules') continue;
      sourceFiles(full, acc);
    } else if (name.endsWith('.ts') && !name.includes('.test.') && !name.includes('.spec.')) {
      acc.push(full);
    }
  }
  return acc;
}

describe('TLS coverage', () => {
  it('wraps every outbound fetch that could negotiate TLS', () => {
    const offenders: string[] = [];
    const exemptSeen = new Set<string>();

    for (const abs of sourceFiles(SRC)) {
      const rel = relative(REPO_ROOT, abs).replace(/\\/g, '/');
      readFileSync(abs, 'utf-8')
        .split('\n')
        .forEach((line, i) => {
          // Only real call sites: `await fetch(` preceded by nothing that already
          // wraps it. Comments and doc blocks start with `*` or `//`.
          const trimmed = line.trim();
          if (trimmed.startsWith('*') || trimmed.startsWith('//')) return;
          if (!/\bawait fetch\(/.test(line) && !/\bvoid fetch\(/.test(line)) return;

          const key = `${rel}:${i + 1}`;
          const exempt = EXEMPT.find((e) => e.file === rel && e.line === i + 1);
          if (exempt) {
            exemptSeen.add(key);
            return;
          }
          offenders.push(`${key} — ${trimmed.slice(0, 80)}`);
        });
    }

    expect(
      offenders,
      `These outbound requests are not wrapped in withRelaxedTls, so they ignore the\n` +
        `user's --insecure / skipSslVerify opt-in and will reject a self-signed\n` +
        `certificate the user chose to accept:\n\n` +
        offenders.join('\n') +
        `\n\nWrap as: await withRelaxedTls(() => fetch(...))\n` +
        `If the call genuinely cannot use TLS (loopback http:// only), add it to EXEMPT\n` +
        `in this file with the reason.`
    ).toEqual([]);
  });

  it('has no stale exemptions', () => {
    // An exemption whose line no longer holds a fetch is worse than none: it reads as
    // "reviewed and fine" while guarding nothing.
    const stale: string[] = [];
    for (const e of EXEMPT) {
      const abs = join(REPO_ROOT, e.file);
      let line: string | undefined;
      try {
        line = readFileSync(abs, 'utf-8').split('\n')[e.line - 1];
      } catch {
        stale.push(`${e.file}:${e.line} — file not found`);
        continue;
      }
      if (!line || !/\b(await|void) fetch\(/.test(line)) {
        stale.push(`${e.file}:${e.line} — no fetch( on this line any more`);
      }
    }
    expect(stale, `Stale TLS exemptions:\n${stale.join('\n')}`).toEqual([]);
  });
});
