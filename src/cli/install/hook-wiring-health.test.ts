import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assessHookWiring, claudeSettingsFiles, openloreStep, shellWords } from './hook-wiring-health.js';
import { checkAgentHooks } from '../commands/doctor.js';

const dirs: string[] = [];
const fresh = () => { const d = mkdtempSync(join(tmpdir(), 'olhookwiring-')); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const NODE = process.execPath;
const settings = (file: string, hooks: Record<string, unknown[]>) => {
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, JSON.stringify({ hooks }));
};
const group = (command: string, marked = true) => ({ matcher: '', ...(marked ? { _openlore: true } : {}), hooks: [{ type: 'command', command }] });

describe('reading a hook command', () => {
  it('splits words, honoring quotes', () => {
    expect(shellWords(`'/a b/node' "/c d/openlore/dist/cli/index.js" orient --inject`)).toEqual(['/a b/node', '/c d/openlore/dist/cli/index.js', 'orient', '--inject']);
    expect(shellWords('')).toEqual([]);
    expect(shellWords(`x ''`)).toEqual(['x', '']);
  });

  it('names the OpenLore step, and nothing for a user command', () => {
    expect(openloreStep(`'/n/node' '/x/OpenLore/dist/cli/index.js' orient --inject`)).toBe('orient --inject');
    expect(openloreStep(`"C:\\nodejs\\node.exe" "C:\\Users\\me\\openlore\\dist\\cli\\index.js" hook before-edit`)).toBe('hook before-edit');
    expect(openloreStep('npx --yes openlore orient --json')).toBe('orient --json');
    expect(openloreStep('echo hello')).toBeUndefined();
    // A guarded command names the entry twice; the step is read after the second.
    expect(openloreStep(`[ -f '/x/openlore/dist/cli/index.js' ] && [ -f '/n/node' ] || exit 0; '/n/node' '/x/openlore/dist/cli/index.js' hook after-tools`)).toBe('hook after-tools');
    expect(openloreStep('command -v npx >/dev/null 2>&1 || exit 0; npx --yes openlore orient --inject')).toBe('orient --inject');
    expect(openloreStep('node /tmp/other/dist/cli/index.js orient --inject')).toBeUndefined();
  });
});

describe('assessHookWiring', () => {
  it('reports a runtime that no longer exists', async () => {
    const root = fresh();
    const gone = join(root, 'gone-openlore', 'dist', 'cli', 'index.js');
    settings(join(root, '.claude', 'settings.json'), { Stop: [group(`'${NODE}' '${gone}' hook before-stop`)] });
    const h = await assessHookWiring([join(root, '.claude', 'settings.json')]);
    expect(h.missing.map(m => m.path)).toEqual([gone]);
    expect(h.duplicates).toEqual([]);
  });

  it('one command in two files is one run, not a duplicate; two commands for one step are', async () => {
    const home = fresh();
    const root = fresh();
    const a = `'${NODE}' '/x/OpenLore/dist/cli/index.js' orient --inject`;
    const b = `'${NODE}' '/x/OpenLore-r36/dist/cli/index.js' orient --inject`;
    settings(join(home, '.claude', 'settings.json'), { UserPromptSubmit: [group(a, false)] });
    settings(join(root, '.claude', 'settings.json'), { UserPromptSubmit: [group(a)], PreToolUse: [{ hooks: [{ type: 'command', command: 'echo mine' }] }] });
    const same = await assessHookWiring(claudeSettingsFiles(root, home));
    expect(same.hooks).toHaveLength(2);
    expect(same.hooks.map(h => h.marked)).toEqual([false, true]);
    expect(same.duplicates).toEqual([]);

    settings(join(home, '.claude', 'settings.json'), { UserPromptSubmit: [group(a, false), group(b)] });
    const twice = await assessHookWiring(claudeSettingsFiles(root, home));
    expect(twice.duplicates).toEqual([expect.objectContaining({ event: 'UserPromptSubmit', step: 'orient --inject' })]);
  });

  it('a missing or corrupt settings file is no hook', async () => {
    const root = fresh();
    writeFileSync(join(root, 'bad.json'), '{"hooks": {');
    expect((await assessHookWiring([join(root, 'bad.json'), join(root, 'absent.json')])).hooks).toEqual([]);
  });
});

describe('openlore doctor: Agent hooks', () => {
  it('is absent when no OpenLore hook is wired', async () => {
    expect(await checkAgentHooks(fresh(), fresh())).toBeNull();
  });

  it('warns about a missing runtime, names the path, and gives openlore install as the fix', async () => {
    const root = fresh();
    const gone = join(root, 'gone-openlore', 'dist', 'cli', 'index.js');
    settings(join(root, '.claude', 'settings.json'), { Stop: [group(`'${NODE}' '${gone}' hook before-stop`)] });
    const r = (await checkAgentHooks(root, fresh()))!;
    expect(r.status).toBe('warn');
    expect(r.detail).toContain(gone);
    expect(r.fix).toBe("Run 'openlore install' to re-wire the hooks to this install");
  });

  it('says a guarded command skips itself, and an unguarded one fails', async () => {
    const root = fresh();
    const gone = join(root, 'gone-openlore', 'dist', 'cli', 'index.js');
    const plain = `'${NODE}' '${gone}' hook before-stop`;
    settings(join(root, '.claude', 'settings.json'), { Stop: [group(`[ -f '${gone}' ] && [ -f '${NODE}' ] || exit 0; ${plain}`)] });
    expect((await checkAgentHooks(root, fresh()))!.detail).toMatch(/1 hook command\(s\) name a runtime that no longer exists .*so they do nothing: each skips itself/);
    settings(join(root, '.claude', 'settings.json'), { Stop: [group(plain)] });
    expect((await checkAgentHooks(root, fresh()))!.detail).toMatch(/so they fail on every event/);
  });

  it('warns about a step that runs twice, once per distinct command, and is ok otherwise', async () => {
    const home = fresh();
    const root = fresh();
    const entry = join(root, 'OpenLore', 'dist', 'cli', 'index.js');
    mkdirSync(join(entry, '..'), { recursive: true });
    writeFileSync(entry, '');
    const a = `'${NODE}' '${entry}' orient --inject`;
    settings(join(root, '.claude', 'settings.json'), { UserPromptSubmit: [group(a)] });
    expect((await checkAgentHooks(root, home))!.status).toBe('ok');
    settings(join(home, '.claude', 'settings.json'), { UserPromptSubmit: [group(`${a} `, false)] });
    const r = (await checkAgentHooks(root, home))!;
    expect(r.status).toBe('warn');
    expect(r.detail).toMatch(/UserPromptSubmit runs `orient --inject` 2 times, once per distinct command/);
    expect(r.detail).toContain('[not marked by openlore install]');
  });
});
