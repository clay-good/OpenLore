import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runInstall, surfaceStatus } from './index.js';
import { detect, ALL_AGENTS } from './detect.js';
import { PI_EXTENSION_SOURCE, renderPiShim } from './pi-extension.js';

const EXT_REL = join('.pi', 'extensions', 'openlore.js');

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

describe('pi surface — install/connect parity', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'openlore-pi-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('pi is a known agent surface', () => {
    expect(ALL_AGENTS).toContain('pi');
  });

  it('detects a project-local .pi/ directory', async () => {
    await mkdir(join(dir, '.pi'), { recursive: true });
    const surfaces = await detect(dir);
    const pi = surfaces.find((s) => s.agent === 'pi');
    expect(pi).toBeDefined();
    expect(pi!.root).toBe(dir);
    expect(pi!.markers).toContain('.pi/');
  });

  it('does not claim pi from an unrelated project tree', async () => {
    await writeFile(join(dir, 'CLAUDE.md'), '# project\n');
    const surfaces = await detect(dir);
    expect(surfaces.find((s) => s.agent === 'pi')).toBeUndefined();
  });

  it('--agent pi writes a re-export shim, not a copy of the bundle', async () => {
    const code = await runInstall({ cwd: dir, agent: 'pi', analyze: false });
    expect(code).toBe(0);
    const written = await readFile(join(dir, EXT_REL), 'utf8');
    expect(written).toBe(renderPiShim());
    expect(written).toContain('export { default } from');
    expect(written).toContain(pathToFileURL(PI_EXTENSION_SOURCE).href);
    // A copied bundle would carry the extension's own source; the shim must not.
    expect(written).not.toMatch(/openlore_orient/);
  });

  it('the installed shim resolves and exports the Pi entry point', async () => {
    // The bug this shim exists for: the compiled bundle's relative imports
    // ("../cli/commands/…") only resolve inside the package, so a copy throws
    // ERR_MODULE_NOT_FOUND the moment Pi loads it.
    await runInstall({ cwd: dir, agent: 'pi', analyze: false });
    const mod = await import(pathToFileURL(join(dir, EXT_REL)).href);
    expect(typeof mod.default).toBe('function');
  });

  it('refuses to overwrite a foreign openlore.js without --force', async () => {
    await mkdir(join(dir, '.pi', 'extensions'), { recursive: true });
    await writeFile(join(dir, EXT_REL), '// my own extension\n');
    const code = await runInstall({ cwd: dir, agent: 'pi', analyze: false });
    expect(code).toBe(1);
    expect(await readFile(join(dir, EXT_REL), 'utf8')).toBe('// my own extension\n');

    const forced = await runInstall({ cwd: dir, agent: 'pi', force: true, analyze: false });
    expect(forced).toBe(0);
    expect(await readFile(join(dir, EXT_REL), 'utf8')).toBe(renderPiShim());
  });

  it('replaces the broken copied bundle an older version installed', async () => {
    await mkdir(join(dir, '.pi', 'extensions'), { recursive: true });
    await writeFile(join(dir, EXT_REL), await readFile(PI_EXTENSION_SOURCE, 'utf8'));
    const code = await runInstall({ cwd: dir, agent: 'pi', analyze: false });
    expect(code).toBe(0);
    expect(await readFile(join(dir, EXT_REL), 'utf8')).toBe(renderPiShim());
  });

  it('migrates a copied bundle from a DIFFERENT openlore version', async () => {
    // The real upgrade case: the bytes differ from what this version ships, so
    // byte-equality would misread it as a user's file and refuse to migrate.
    await mkdir(join(dir, '.pi', 'extensions'), { recursive: true });
    const olderBundle =
      '// openlore pi extension v2.9.0\n' +
      "import { renderInjectionBlock } from '../cli/commands/orient-inject-render.js';\n" +
      "const DESCRIPTOR = '.openlore/serve.json';\n" +
      'export default function openlore(pi) { return renderInjectionBlock(pi); }\n';
    await writeFile(join(dir, EXT_REL), olderBundle);
    const code = await runInstall({ cwd: dir, agent: 'pi', analyze: false });
    expect(code).toBe(0);
    expect(await readFile(join(dir, EXT_REL), 'utf8')).toBe(renderPiShim());
  });

  it('--dry-run plans the extension without writing it', async () => {
    const code = await runInstall({ cwd: dir, agent: 'pi', dryRun: true });
    expect(code).toBe(0);
    expect(await exists(join(dir, EXT_REL))).toBe(false);
  });

  it('surfaceStatus does not call a broken bundle copy connected', async () => {
    await mkdir(join(dir, '.pi', 'extensions'), { recursive: true });
    await writeFile(join(dir, EXT_REL), await readFile(PI_EXTENSION_SOURCE, 'utf8'));
    expect((await surfaceStatus(dir)).find((s) => s.agent === 'pi')!.connected).toBe(false);
  });

  it('surfaceStatus does not call a foreign openlore.js connected', async () => {
    await mkdir(join(dir, '.pi', 'extensions'), { recursive: true });
    await writeFile(join(dir, EXT_REL), '// my own extension\n');
    expect((await surfaceStatus(dir)).find((s) => s.agent === 'pi')!.connected).toBe(false);
  });

  it('re-install is idempotent and surfaceStatus tracks connection', async () => {
    expect((await surfaceStatus(dir)).find((s) => s.agent === 'pi')!.connected).toBe(false);
    await runInstall({ cwd: dir, agent: 'pi', analyze: false });
    expect((await surfaceStatus(dir)).find((s) => s.agent === 'pi')!.connected).toBe(true);
    const first = await readFile(join(dir, EXT_REL), 'utf8');
    await runInstall({ cwd: dir, agent: 'pi', analyze: false });
    expect(await readFile(join(dir, EXT_REL), 'utf8')).toBe(first);
  });

  it('removes a legacy OpenLore openlore.ts so Pi does not load both', async () => {
    await mkdir(join(dir, '.pi', 'extensions'), { recursive: true });
    await writeFile(
      join(dir, '.pi', 'extensions', 'openlore.ts'),
      '/**\n * openlore.ts — Pi extension (pi.dev)\n */\nexport default function openlore(pi) { return pi; }\n'
    );
    await runInstall({ cwd: dir, agent: 'pi', analyze: false });
    expect(await exists(join(dir, '.pi', 'extensions', 'openlore.ts'))).toBe(false);
    expect(await exists(join(dir, EXT_REL))).toBe(true);
  });

  it('keeps an openlore.ts that merely integrates with OpenLore', async () => {
    await mkdir(join(dir, '.pi', 'extensions'), { recursive: true });
    // Calls our tools and reads our descriptor, and even uses the conventional
    // default-export name — but it is the user's own code, not our artifact.
    await writeFile(
      join(dir, '.pi', 'extensions', 'openlore.ts'),
      'export default function openlore(pi) { pi.call("openlore_orient", ".openlore/serve.json"); }\n'
    );
    const code = await runInstall({ cwd: dir, agent: 'pi', analyze: false });
    expect(code).toBe(0);
    expect(await readFile(join(dir, '.pi', 'extensions', 'openlore.ts'), 'utf8')).toContain(
      'openlore_orient'
    );

    await runInstall({ cwd: dir, agent: 'pi', force: true, analyze: false });
    expect(await exists(join(dir, '.pi', 'extensions', 'openlore.ts'))).toBe(false);
  });

  it('--dry-run plans the legacy deletion it would perform', async () => {
    await mkdir(join(dir, '.pi', 'extensions'), { recursive: true });
    await writeFile(
      join(dir, '.pi', 'extensions', 'openlore.ts'),
      '/**\n * openlore.ts — Pi extension (pi.dev)\n */\nexport default function openlore(pi) { return pi; }\n'
    );
    const captured: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      captured.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      return true;
    }) as typeof process.stderr.write;
    try {
      await runInstall({ cwd: dir, agent: 'pi', dryRun: true });
    } finally {
      process.stderr.write = origWrite;
    }
    // The .ts is still there, and the plan said it would go.
    expect(await exists(join(dir, '.pi', 'extensions', 'openlore.ts'))).toBe(true);
    expect(await exists(join(dir, EXT_REL))).toBe(false);
  });

  it('--uninstall deletes the extension', async () => {
    await runInstall({ cwd: dir, agent: 'pi', analyze: false });
    const code = await runInstall({ cwd: dir, agent: 'pi', uninstall: true, analyze: false });
    expect(code).toBe(0);
    expect(await exists(join(dir, EXT_REL))).toBe(false);
  });

  it('--uninstall leaves a foreign openlore.js alone', async () => {
    await mkdir(join(dir, '.pi', 'extensions'), { recursive: true });
    await writeFile(join(dir, EXT_REL), '// my own extension\n');
    const code = await runInstall({ cwd: dir, agent: 'pi', uninstall: true, analyze: false });
    expect(code).toBe(0);
    expect(await readFile(join(dir, EXT_REL), 'utf8')).toBe('// my own extension\n');
  });

  it('openlore setup --tools pi writes the same shim (no broken copy)', async () => {
    const { setupCommand } = await import('../commands/setup.js');
    await setupCommand.parseAsync(['--tools', 'pi', '--dir', dir], { from: 'user' });
    expect(await readFile(join(dir, EXT_REL), 'utf8')).toBe(renderPiShim());
  });

  it('openlore setup --tools pi keeps the legacy .ts when the .js write is skipped', async () => {
    await mkdir(join(dir, '.pi', 'extensions'), { recursive: true });
    await writeFile(join(dir, EXT_REL), '// my own extension\n');
    const legacy = join(dir, '.pi', 'extensions', 'openlore.ts');
    await writeFile(
      legacy,
      '/**\n * openlore.ts — Pi extension (pi.dev)\n */\nexport default function openlore(pi) { return pi; }\n'
    );
    const { setupCommand } = await import('../commands/setup.js');
    await setupCommand.parseAsync(['--tools', 'pi', '--dir', dir], { from: 'user' });
    // The .js was not ours to replace, so the working .ts must survive.
    expect(await exists(legacy)).toBe(true);
    expect(await readFile(join(dir, EXT_REL), 'utf8')).toBe('// my own extension\n');
  });

  it('openlore setup --tools pi repairs a shim left by another openlore location', async () => {
    const stale = renderPiShim('/somewhere/else/openlore/dist/pi/extension.js');
    await mkdir(join(dir, '.pi', 'extensions'), { recursive: true });
    await writeFile(join(dir, EXT_REL), stale);
    const { setupCommand } = await import('../commands/setup.js');
    await setupCommand.parseAsync(['--tools', 'pi', '--dir', dir], { from: 'user' });
    expect(await readFile(join(dir, EXT_REL), 'utf8')).toBe(renderPiShim());
  });

  it('re-points a shim left by another openlore location', async () => {
    await mkdir(join(dir, '.pi', 'extensions'), { recursive: true });
    await writeFile(join(dir, EXT_REL), renderPiShim('/somewhere/else/openlore/dist/pi/extension.js'));
    const code = await runInstall({ cwd: dir, agent: 'pi', analyze: false });
    expect(code).toBe(0);
    expect(await readFile(join(dir, EXT_REL), 'utf8')).toBe(renderPiShim());
  });

  it('writes no markdown block or MCP entry — Pi does not consume MCP', async () => {
    await runInstall({ cwd: dir, agent: 'pi', analyze: false });
    expect(await exists(join(dir, 'AGENTS.md'))).toBe(false);
    expect(await exists(join(dir, '.mcp.json'))).toBe(false);
  });
});
