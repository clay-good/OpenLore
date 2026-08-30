import { describe, expect, it } from 'vitest';
import { buildGraphSubset } from './mcp-watcher.js';

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
});
