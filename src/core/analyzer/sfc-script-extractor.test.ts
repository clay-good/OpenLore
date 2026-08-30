import { describe, expect, it } from 'vitest';
import { CallGraphBuilder } from './call-graph.js';
import {
  SCRIPT_CONTAINER_FORMATS,
  describeScriptContainerBoundaries,
  extractScriptContainer,
  summarizeScriptContainers,
} from './sfc-script-extractor.js';

const FIXTURES = [
  { format: 'Vue', path: 'src/App.vue', open: '<script lang="ts">' },
  { format: 'Svelte', path: 'src/App.svelte', open: '<script>' },
  { format: 'Astro', path: 'src/App.astro', open: '<script>' },
] as const;

describe('SFC script-container extraction', () => {
  it('keeps script bodies at their original offsets and dispatches typed/untyped blocks', () => {
    const typed = ['<template />', '<script lang="ts">', 'function save(): void {}', '</script>'].join('\n');
    const untyped = ['<script>', 'function save() {}', '</script>'].join('\n');
    const vue = extractScriptContainer('App.vue', typed)!;
    const svelte = extractScriptContainer('App.svelte', untyped)!;

    expect(vue.language).toBe('TypeScript');
    expect(svelte.language).toBe('JavaScript');
    expect(vue.content).toHaveLength(typed.length);
    expect(vue.content!.split('\n').findIndex(line => line.includes('function save')))
      .toBe(typed.split('\n').findIndex(line => line.includes('function save')));
    expect(vue.content).not.toContain('<template');
  });

  for (const fixture of FIXTURES) {
    it(`${fixture.format} yields line-true functions and a resolved edge`, async () => {
      const source = [
        '<section>markup</section>',
        fixture.open,
        'function caller() {',
        '  callee();',
        '}',
        'function callee() {}',
        '</script>',
      ].join('\n');
      const result = await new CallGraphBuilder().build([{
        path: fixture.path,
        content: source,
        language: fixture.format,
      }]);
      const nodes = [...result.nodes.values()];
      const caller = nodes.find(node => node.name === 'caller');
      const callee = nodes.find(node => node.name === 'callee');

      expect(caller?.startLine).toBe(3);
      expect(callee?.startLine).toBe(6);
      expect(result.edges.some(edge =>
        edge.callerId === caller?.id && edge.calleeId === callee?.id,
      )).toBe(true);
    });
  }

  it('resolves a script-block import through the existing TypeScript lane', async () => {
    const vue = [
      '<template><button @click="save()" /></template>',
      '<script lang="ts">',
      "import { helper } from './helper';",
      'export function save() { helper(); }',
      '</script>',
    ].join('\n');
    const result = await new CallGraphBuilder().build([
      { path: 'src/App.vue', content: vue, language: 'Vue' },
      { path: 'src/helper.ts', content: 'export function helper() {}', language: 'TypeScript' },
    ]);
    const save = [...result.nodes.values()].find(node => node.name === 'save');
    const helper = [...result.nodes.values()].find(node => node.name === 'helper');
    const edge = result.edges.find(candidate =>
      candidate.callerId === save?.id && candidate.calleeId === helper?.id,
    );

    expect(edge?.confidence).toBe('import');
  });

  it('does not invent calls from templates or Svelte reactive statements', async () => {
    const svelte = [
      '<button on:click={save}>save</button>',
      '<script>',
      '$: save();',
      'function save() {}',
      '</script>',
    ].join('\n');
    const result = await new CallGraphBuilder().build([
      { path: 'src/App.svelte', content: svelte, language: 'Svelte' },
    ]);

    expect([...result.nodes.values()].map(node => node.name)).toContain('save');
    expect(result.edges).toHaveLength(0);
  });

  it('keeps the claimed-format fixture set complete and discloses remaining semantics', () => {
    expect(new Set(FIXTURES.map(fixture => fixture.format)))
      .toEqual(new Set(SCRIPT_CONTAINER_FORMATS));
    const boundaries = summarizeScriptContainers(FIXTURES.map(fixture => ({
      filePath: fixture.path,
      format: fixture.format,
      scriptBlockCount: 1,
      extractedScriptBlockCount: 1,
    })));
    const disclosure = describeScriptContainerBoundaries(boundaries)!;

    expect(disclosure).toContain('3 script blocks extracted');
    expect(disclosure).toContain('template expressions');
    expect(disclosure).toContain('framework macros');
    expect(disclosure).toContain('Svelte reactive statements');
  });
});
