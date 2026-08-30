import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildGraphSubset } from './mcp-watcher.js';
import { CallGraphBuilder, extractFileParseHealth, extractFileStyle } from '../analyzer/call-graph.js';

describe('buildGraphSubset — SFC script blocks', () => {
  it('preserves extracted nodes and edges during an incremental Vue refresh', async () => {
    const source = [
      '<template><button @click="save">save</button></template>',
      '<script lang="ts">',
      'function save(): void { persist(); }',
      'function persist(): void {}',
      '</script>',
    ].join('\n');

    const { nodes, edges } = await buildGraphSubset('src/App.vue', source, [], '/tmp');
    const save = nodes.find(node => node.name === 'save');
    const persist = nodes.find(node => node.name === 'persist');

    expect(save?.startLine).toBe(3);
    expect(persist?.startLine).toBe(4);
    expect(edges.some(edge => edge.callerId === save?.id && edge.calleeId === persist?.id))
      .toBe(true);
  });

  it('re-resolves requested callers when an SFC loses its final script block', async () => {
    const root = await mkdtemp(join(tmpdir(), 'openlore-sfc-watch-'));
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src/caller.ts'), [
      'function caller() { helper(); }',
      'function helper() {}',
    ].join('\n'));

    const result = await buildGraphSubset(
      'src/App.vue',
      '<template><p>no script remains</p></template>',
      ['src/caller.ts'],
      root,
    );
    expect(result.analyzedFileHashes.has('src/caller.ts')).toBe(true);
    expect(result.edges.some(edge =>
      edge.callerId === 'src/caller.ts::caller' && edge.calleeId === 'src/caller.ts::helper',
    ))
      .toBe(true);
  });

  it('keeps cold and incremental SFC style and parse-health labels aligned', async () => {
    const source = [
      '<script lang="ts">',
      'function broken(flag: boolean) { if (flag) { return 1; }',
      '</script>',
    ].join('\n');
    const file = { path: 'src/App.vue', content: source, language: 'Vue' };
    const cold = await new CallGraphBuilder().build([file]);
    const incrementalStyle = await extractFileStyle(file);
    const incrementalHealth = await extractFileParseHealth(file);

    expect(cold.styleByFile?.get(file.path)?.language).toBe('Vue');
    expect(incrementalStyle?.language).toBe('Vue');
    expect(incrementalStyle?.counters).toEqual(cold.styleByFile?.get(file.path)?.counters);
    expect(cold.parseHealthByFile?.get(file.path)?.language).toBe('Vue');
    expect(incrementalHealth?.language).toBe('Vue');
  });
});
