import { inspectConfiguration } from './inspect.js';
import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpWatcher } from '../services/mcp-watcher.js';
import { getDefaultConfig } from '../services/config-manager.js';
import { CONFIGURATION_MATERIAL_WATCH_DIRECTORIES } from '../../constants.js';

describe('real configuration watch subscriptions', () => {
  it('prunes declared output before descending and preserves source subscriptions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ol-configuration-watch-'));
    const outputPath = join(root, '.openlore/analysis');
    await mkdir(outputPath, { recursive: true });
    await mkdir(join(root, 'src'));
    await writeFile(join(root, 'src/main.ts'), 'export const main = 1;');
    await writeFile(
      join(outputPath, 'llm-context.json'),
      JSON.stringify({ signatures: [], callGraph: null })
    );
    for (let i = 0; i < 100; i++) {
      const dir = join(root, 'generated', 'chunk-' + i);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'output.ts'), 'export const output = 1;');
    }
    await writeFile(join(root, '.gitignore'), 'generated/\n');
    const config = getDefaultConfig('nodejs', 'openspec');
    const configPath = join(root, '.openlore/config.json');
    await writeFile(configPath, JSON.stringify(config));
    let watcher = new McpWatcher({ rootPath: root, outputPath, embed: false });
    try {
      const before = performance.now();
      await watcher.start();
      const legacyMilliseconds = performance.now() - before;
      const legacy = watcher.configurationWatchedDirectories;
      expect(
        legacy.filter((p) => p === 'generated' || p.startsWith('generated/')).length
      ).toBeGreaterThanOrEqual(CONFIGURATION_MATERIAL_WATCH_DIRECTORIES);
      await watcher.stop();
      await writeFile(
        configPath,
        JSON.stringify({
          ...config,
          filePolicies: {
            rules: [
              {
                id: 'generated',
                pattern: 'generated/',
                lanes: { watch: 'exclude' },
                reason: 'Declared compiler output',
              },
            ],
          },
        })
      );
      watcher = new McpWatcher({ rootPath: root, outputPath, embed: false });
      const after = performance.now();
      await watcher.start();
      const filteredMilliseconds = performance.now() - after;
      const filtered = watcher.configurationWatchedDirectories;
      expect(filtered.some((p) => p === 'generated' || p.startsWith('generated/'))).toBe(false);
      expect(filtered).toContain('src');
      const discoveryBefore = await inspectConfiguration({ rootPath: root });
      for (let i = 100; i < 1000; i++) await mkdir(join(root, 'generated', 'chunk-' + i));
      const discoveryAfter = await inspectConfiguration({ rootPath: root });
      expect(discoveryAfter.counts.entries).toBe(discoveryBefore.counts.entries);
      expect(discoveryAfter.counts.entries).toBeLessThan(20);
      expect(watcher.configurationWatchedDirectories).toEqual(filtered);

      console.info(
        JSON.stringify({
          fixture: '100 generated subdirectories',
          legacyWatchedDirectories: legacy.length,
          filteredWatchedDirectories: filtered.length,
          legacyMilliseconds,
          filteredMilliseconds,
          scope: 'chokidar subscriptions; not OS handle counts or a throughput benchmark',
        })
      );
    } finally {
      await watcher.stop();
      await rm(root, { recursive: true, force: true });
    }
  });
});
