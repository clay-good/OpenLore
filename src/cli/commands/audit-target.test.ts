/**
 * `openlore audit [directory]` must audit the directory it was given, or refuse
 * (change: fix-cli-input-validation).
 *
 * It resolved its target with `join(process.cwd(), directory)`, and `path.join` never treats its
 * second segment as absolute — so `openlore audit /repo` from elsewhere audited `cwd + /repo`.
 * Two things followed: a confident `analysis-unavailable` verdict about a repository that is in
 * fact fully analyzed, and a phantom `.openlore/analysis/` tree created under whatever directory
 * the caller happened to be standing in, with exit 0 throughout.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '../../../dist/cli/index.js');
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 3 }); });

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), 'ol-audit-target-'));
  dirs.push(root);
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src/a.ts'), 'export function a() { return 1; }\n');
  writeFileSync(join(root, 'package.json'), '{"name":"t","version":"1.0.0"}');
  return root;
}

function run(args: string[], cwd: string): { code: number; out: string } {
  try {
    const out = execFileSync('node', [CLI, ...args], { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: 0, out };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

describe.skipIf(!existsSync(CLI))('openlore audit target resolution', () => {
  it('refuses a directory that does not exist, and creates nothing', () => {
    const outside = mkdtempSync(join(tmpdir(), 'ol-audit-cwd-'));
    dirs.push(outside);
    const missing = join(outside, 'not-here');
    const { code, out } = run(['audit', missing], outside);
    expect(code, 'a missing target must be a usage failure, not a verdict').toBe(1);
    expect(out).toContain('Directory not found');
    // The old behaviour mkdir -p'd its report path on the way out.
    expect(existsSync(join(outside, 'not-here')), 'audit must not create its own target').toBe(false);
  });

  it('audits an absolute target rather than cwd + the path, and writes nothing under cwd', () => {
    const target = repo();
    const outside = mkdtempSync(join(tmpdir(), 'ol-audit-cwd-'));
    dirs.push(outside);
    const { code } = run(['audit', target, '--json'], outside);
    expect(code).toBe(0);
    // `join(cwd, '/abs')` would have produced `<outside>/<abs>` and written the report there.
    const phantom = join(outside, target.replace(/^\//, ''));
    expect(existsSync(phantom), `audit wrote outside its target: ${phantom}`).toBe(false);
  });
});
