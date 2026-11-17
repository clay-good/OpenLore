/**
 * A generated repository of fixed size for hook latency measurement (change: hook-reliability,
 * design section 2): 200 TypeScript files with 10 functions each, 2,000 functions in all.
 *
 * Every function calls one function in the next file, so the call graph spans the whole repository.
 * Every tenth file is a test file (`*.test.ts`) whose functions call the source file before it, so
 * test reachability has real answers. The content depends only on the constants: two builds are
 * byte-identical.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const FIXTURE_FILES = 200;
export const FIXTURE_FUNCTIONS_PER_FILE = 10;

/** The repository-relative path of fixture file `i`. */
export function fixtureFile(i: number): string {
  return i % 10 === 9 ? `src/mod${i}.test.ts` : `src/mod${i}.ts`;
}

function sourceOf(i: number): string {
  const isTest = i % 10 === 9;
  // A test file calls the source file before it; a source file calls the next source file.
  const target = isTest ? i - 1 : (i + 1) % FIXTURE_FILES;
  const callee = target % 10 === 9 ? (target + 1) % FIXTURE_FILES : target;
  const lines = [`import { f${callee}_0, f${callee}_1 } from './mod${callee}.js';`, ''];
  for (let j = 0; j < FIXTURE_FUNCTIONS_PER_FILE; j++) {
    lines.push(
      `export function f${i}_${j}(n: number): number {`,
      `  const base = n * ${j + 1} + ${i};`,
      `  return base > 1000 ? base : f${callee}_${j % 2}(base + 1);`,
      '}',
      '',
    );
  }
  return lines.join('\n');
}

/** Write the fixture into `dir` (which must be empty or absent). Returns its relative file paths. */
export function writeHookFixture(dir: string): string[] {
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify({ name: 'hook-fixture', private: true, type: 'module' }, null, 2)}\n`);
  writeFileSync(join(dir, 'tsconfig.json'), `${JSON.stringify({ compilerOptions: { module: 'nodenext', strict: true } }, null, 2)}\n`);
  const files: string[] = [];
  for (let i = 0; i < FIXTURE_FILES; i++) {
    const rel = fixtureFile(i);
    writeFileSync(join(dir, rel), sourceOf(i));
    files.push(rel);
  }
  return files;
}
