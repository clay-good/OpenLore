import { describe, expect, it } from 'vitest';
import { MAX_SCRIPT_CONTAINER_CHARS } from '../../constants.js';
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

    expect(vue.lanes.map(lane => lane.language)).toEqual(['TypeScript']);
    expect(svelte.lanes.map(lane => lane.language)).toEqual(['JavaScript']);
    expect(vue.lanes[0].content).toHaveLength(typed.length);
    expect(vue.lanes[0].content.split('\n').findIndex(line => line.includes('function save')))
      .toBe(typed.split('\n').findIndex(line => line.includes('function save')));
    expect(vue.lanes[0].content).not.toContain('<template');
  });

  for (const fixture of FIXTURES) {
    it(`${fixture.format} yields line-true functions and a resolved edge`, async () => {
      const source = [
        '<section>markup</section>',
        fixture.open,
        'function caller() {',
        '  if (true) callee();',
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
      expect(result.cfgs?.get(caller!.id)?.blocks.some(block => block.kind === 'branch')).toBe(true);
      expect(result.styleByFile?.get(fixture.path)).toMatchObject({
        language: fixture.format,
        functionsSampled: 2,
      });
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

  it('blanks complete multiline Svelte reactive blocks', async () => {
    const source = [
      '<script>',
      'function target() {}',
      '$: {',
      '  const derived = () => target();',
      '}',
      '</script>',
    ].join('\n');
    const result = await new CallGraphBuilder().build([
      { path: 'src/App.svelte', content: source, language: 'Svelte' },
    ]);

    expect([...result.nodes.values()].map(node => node.name)).toEqual(['target']);
    expect(result.edges).toEqual([]);
  });

  it('ignores script-looking text inside container comments', async () => {
    const source = [
      '<!-- <script>function phantom() { real(); }</script> -->',
      '<script>function real() {}</script>',
    ].join('\n');
    const result = await new CallGraphBuilder().build([
      { path: 'src/App.vue', content: source, language: 'Vue' },
    ]);

    expect([...result.nodes.values()].map(node => node.name)).toEqual(['real']);
    expect(result.edges).toEqual([]);
  });

  it('does not treat a comment marker inside script text as a container comment', async () => {
    const source = [
      '<script>const marker = "<!--"; function first() {}</script>',
      '<script>function second() { first(); }</script>',
    ].join('\n');
    const result = await new CallGraphBuilder().build([{
      path: 'src/App.vue',
      content: source,
      language: 'Vue',
    }]);
    const nodes = [...result.nodes.values()];
    const first = nodes.find(node => node.name === 'first');
    const second = nodes.find(node => node.name === 'second');

    expect(nodes.map(node => node.name)).toEqual(expect.arrayContaining(['first', 'second']));
    expect(result.edges.some(edge =>
      edge.callerId === second?.id && edge.calleeId === first?.id,
    )).toBe(true);
  });

  it('does not treat a comment marker inside a markup attribute as a comment', () => {
    const extraction = extractScriptContainer('src/App.vue', [
      '<template><div title="<!--"></div></template>',
      '<script>function real() {}</script>',
    ].join('\n'))!;

    expect(extraction.scriptBlockCount).toBe(1);
    expect(extraction.lanes[0]?.content).toContain('function real');
  });

  it('does not let Astro frontmatter comparisons consume a later script block', () => {
    const extraction = extractScriptContainer('src/Page.astro', [
      '---',
      'const small = value<limit;',
      '---',
      '<script>function real() {}</script>',
    ].join('\n'))!;

    expect(extraction.scriptBlockCount).toBe(1);
    expect(extraction.lanes[0]?.content).toContain('function real');
  });

  it('skips quoted comment markers in dotted Astro component tags', () => {
    const extraction = extractScriptContainer(
      'src/Page.astro',
      '<UI.Button title="<!--" /><script>function real() {}</script>',
    )!;

    expect(extraction.scriptBlockCount).toBe(1);
    expect(extraction.lanes[0]?.content).toContain('function real');
  });

  it('does not let a template comparison consume a later script block', () => {
    const extraction = extractScriptContainer('src/App.svelte', [
      '{value<limit && ok}',
      '<script>function real() {}</script>',
    ].join('\n'))!;

    expect(extraction.scriptBlockCount).toBe(1);
    expect(extraction.lanes[0]?.content).toContain('function real');
  });

  it('scans many script blocks without rescanning prior container text', () => {
    const source = Array.from({ length: 10_000 }, (_, index) =>
      `<script>function f${index}() {}</script>`,
    ).join('\n');
    const extraction = extractScriptContainer('src/App.vue', source)!;

    expect(extraction.scriptBlockCount).toBe(10_000);
    expect(extraction.extractedScriptBlockCount).toBe(10_000);
  });

  it('dispatches mixed untyped and typed blocks through separate lanes', () => {
    const extraction = extractScriptContainer('src/App.vue', [
      '<script>function plain() {}</script>',
      '<script lang="ts">function typed(value: number): number { return value; }</script>',
    ].join('\n'))!;

    expect(extraction.lanes.map(lane => lane.language)).toEqual(['JavaScript', 'TypeScript']);
    expect(extraction.lanes[0].content).toContain('function plain');
    expect(extraction.lanes[0].content).not.toContain('function typed');
    expect(extraction.lanes[1].content).toContain('function typed');
    expect(extraction.lanes[1].content).not.toContain('function plain');
  });

  it('counts an empty supported block as extracted', () => {
    expect(extractScriptContainer('src/App.astro', '<script></script>')).toMatchObject({
      scriptBlockCount: 1,
      extractedScriptBlockCount: 1,
      lanes: [],
      sizeCapped: false,
    });
  });

  it('caps extraction before allocating full-file parser lanes', () => {
    const source = `<script>${'x'.repeat(MAX_SCRIPT_CONTAINER_CHARS)}</script>`;
    const extraction = extractScriptContainer('src/Huge.vue', source)!;

    expect(extraction).toMatchObject({
      scriptBlockCount: 1,
      extractedScriptBlockCount: 0,
      lanes: [],
      sizeCapped: true,
    });
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
