/**
 * The OpenSpec spec source (change: spec-framework-neutrality, task 4.2).
 *
 * Owns the one listing of `<openspec>/specs/<domain>/spec.md` that `loadSpecCorpus` and
 * `buildSpecMap` share, the one heading parser for requirements and scenarios, and the detection of
 * an OpenSpec corpus. A bare `specs/` or `docs/specs` counts as OpenSpec only when a spec in it has a
 * `### Requirement:` heading: the same layout is Spec Kit's.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { OPENSPEC_DIR } from '../../constants.js';
import { structuralMarkdownLines } from '../generator/openspec-compat.js';
import { isConfinedPath } from '../../utils/path-confinement.js';
import type { OpenLoreConfig } from '../../types/index.js';
import type { SpecItem, SpecSource } from './types.js';

export interface SpecDomainEntry {
  /** The domain directory name. */
  domain: string;
  /** `<specsDir>/<domain>/spec.md`, joined the way callers joined it before. */
  specPath: string;
}

/**
 * The domain directories of a specs folder, in `readdir` order, each with its `spec.md` path.
 * Throws when the folder cannot be listed; each caller keeps its own policy for that, and its own
 * filters (structural domains, confinement), so its output is unchanged.
 */
export async function readSpecDomainEntries(specsDir: string): Promise<SpecDomainEntry[]> {
  const entries = await readdir(specsDir, { withFileTypes: true });
  const out: SpecDomainEntry[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const domain = String(entry.name);
    out.push({ domain, specPath: join(specsDir, domain, 'spec.md') });
  }
  return out;
}

/**
 * Every entry name in a specs folder, in `readdir` order, files and links included. For the listers
 * that check `<name>/spec.md` themselves; throws when the folder cannot be listed.
 */
export async function readSpecFolderNames(specsDir: string): Promise<string[]> {
  return readdir(specsDir);
}

/**
 * Every `spec.md` at or below `dir`, at most `maxDepth` folders down, skipping dot-folders, in
 * `readdir` order. A folder that cannot be listed adds nothing.
 */
export async function findNestedSpecFiles(dir: string, maxDepth: number, depth = 0): Promise<string[]> {
  if (depth > maxDepth) return [];
  let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const found: string[] = [];
  for (const entry of entries) {
    if (entry.isFile() && entry.name === 'spec.md') found.push(join(dir, entry.name));
    else if (entry.isDirectory() && !entry.name.startsWith('.')) found.push(...await findNestedSpecFiles(join(dir, entry.name), maxDepth, depth + 1));
  }
  return found;
}

const REQUIREMENT_HEADING =/^###\s+Requirement:\s*(.+)/;
const SCENARIO_HEADING = /^####\s+Scenario:\s*(.+)/;

/** Requirements and scenarios of one spec, by heading, outside code fences. */
export function parseOpenSpecItems(content: string, file: string, group: string): SpecItem[] {
  const items: SpecItem[] = [];
  for (const [index, line] of structuralMarkdownLines(content).entries()) {
    const req = line.match(REQUIREMENT_HEADING);
    const sc = req ? null : line.match(SCENARIO_HEADING);
    const m = req ?? sc;
    if (!m) continue;
    const name = m[1].trim();
    items.push({ id: `openspec:${group}/${name}`, text: name, file, line: index + 1, kind: req ? 'requirement' : 'scenario' });
  }
  return items;
}

/** Whether markdown text has a requirement heading outside code fences. */
export function hasRequirementHeading(content: string): boolean {
  return structuralMarkdownLines(content).some(line => REQUIREMENT_HEADING.test(line));
}

export interface DetectedOpenSpecRoot {
  /** The OpenSpec root, relative to the project root (`openspecPath`). `.` is a bare `specs/`. */
  root: string;
  /** `<root>/specs`, relative to the project root. */
  specsRel: string;
  /** Count of `*.md` files beneath the specs folder. */
  count: number;
}

/**
 * An existing OpenSpec corpus at one of the default roots, or null. `openspec/specs` with any
 * `*.md` counts; `docs/specs` and a bare `specs/` count only when a spec there has a
 * `### Requirement:` heading.
 */
export async function detectOpenSpecRoot(rootPath: string): Promise<DetectedOpenSpecRoot | null> {
  for (const root of [OPENSPEC_DIR, 'docs', '.']) {
    const specsRel = root === '.' ? 'specs' : `${root}/specs`;
    const files: string[] = [];
    try {
      const stack = [join(rootPath, specsRel)];
      while (stack.length) {
        const dir = stack.pop()!;
        for (const d of await readdir(dir, { withFileTypes: true })) {
          if (d.isDirectory()) stack.push(join(dir, d.name));
          else if (d.name.endsWith('.md')) files.push(join(dir, d.name));
        }
      }
    } catch {
      continue; // no specs folder here
    }
    if (!files.length) continue;
    if (root !== OPENSPEC_DIR && !(await someFile(files, hasRequirementHeading))) continue;
    return { root, specsRel, count: files.length };
  }
  return null;
}

async function someFile(files: string[], test: (text: string) => boolean): Promise<boolean> {
  for (const f of files) {
    try { if (test(await readFile(f, 'utf-8'))) return true; } catch { /* unreadable: not evidence */ }
  }
  return false;
}

function configuredRoot(config: OpenLoreConfig | null): string | undefined {
  return config?.openspecPath?.replace(/^\.\//, '').replace(/\/$/, '') || undefined;
}

export const openspecSource: SpecSource = {
  id: 'openspec',
  async detect(root, config) {
    const configured = configuredRoot(config);
    if (configured !== undefined) {
      const specsDir = join(root, configured, 'specs');
      try {
        const entries = await readSpecDomainEntries(specsDir);
        for (const e of entries) {
          try { await readFile(e.specPath, 'utf-8'); return [`${configured === '.' ? '' : `${configured}/`}specs`]; } catch { /* no spec.md */ }
        }
      } catch { /* absent */ }
      return [];
    }
    const found = await detectOpenSpecRoot(root);
    return found ? [found.specsRel] : [];
  },
  async list(root, config) {
    const [specsRel] = await openspecSource.detect(root, config);
    if (!specsRel) return [];
    const specsDir = join(root, specsRel);
    const items: SpecItem[] = [];
    let entries: SpecDomainEntry[];
    try { entries = await readSpecDomainEntries(specsDir); } catch { return []; }
    for (const e of entries) {
      if (!isConfinedPath(root, e.specPath)) continue;
      let content: string;
      try { content = await readFile(e.specPath, 'utf-8'); } catch { continue; }
      items.push(...parseOpenSpecItems(content, relative(root, e.specPath).replaceAll('\\', '/'), e.domain));
    }
    return items.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  },
};
