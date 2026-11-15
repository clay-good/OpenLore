/**
 * First run creates no spec folder (change: spec-framework-neutrality, task 1.1), on the real
 * filesystem: a repository with no `openspec/` gets none, and an existing one is left untouched.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openloreInit } from './init.js';
import { readOpenLoreConfig } from '../core/services/config-manager.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const fresh = () => {
  const d = mkdtempSync(join(tmpdir(), 'olinit-nospec-'));
  dirs.push(d);
  writeFileSync(join(d, 'package.json'), '{"name":"x","version":"1.0.0"}\n');
  return d;
};

describe('openloreInit on a real directory', () => {
  it('writes its config and creates no openspec/', async () => {
    const root = fresh();
    const r = await openloreInit({ rootPath: root });
    expect(r.created).toBe(true);
    expect(existsSync(join(root, '.openlore', 'config.json'))).toBe(true);
    expect(existsSync(join(root, 'openspec'))).toBe(false);
    // No corpus, so no spec path is recorded, and reading the config adds none back.
    expect(JSON.parse(readFileSync(join(root, '.openlore', 'config.json'), 'utf8'))).not.toHaveProperty('openspecPath');
    expect((await readOpenLoreConfig(root))?.openspecPath).toBeUndefined();
  });

  it('leaves an existing openspec/ exactly as it was', async () => {
    const root = fresh();
    mkdirSync(join(root, 'openspec', 'specs', 'billing'), { recursive: true });
    writeFileSync(join(root, 'openspec', 'specs', 'billing', 'spec.md'), '# Billing\n');
    await openloreInit({ rootPath: root });
    expect(JSON.parse(readFileSync(join(root, '.openlore', 'config.json'), 'utf8')).openspecPath).toBe('openspec');
    expect(readdirSync(join(root, 'openspec'))).toEqual(['specs']);
    expect(readdirSync(join(root, 'openspec', 'specs'))).toEqual(['billing']);
    expect(readFileSync(join(root, 'openspec', 'specs', 'billing', 'spec.md'), 'utf8')).toBe('# Billing\n');
  });
});
