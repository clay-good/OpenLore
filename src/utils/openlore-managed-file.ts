import { extname } from 'node:path';
import { createHash } from 'node:crypto';

export const OPENLORE_BLOCK_BEGIN =
  '<!-- BEGIN OPENLORE (managed — edits inside this block will be overwritten) -->';
export const OPENLORE_BLOCK_END = '<!-- END OPENLORE -->';

const unsafePathPart = (part: string): boolean =>
  !part || part === '__proto__' || part === 'prototype' || part === 'constructor';

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${canonicalize(object[key])}`).join(',')}}`;
}

function shortHash(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex').slice(0, 16);
}

function managedJsonSubset(doc: Record<string, unknown>, paths: string[]): Record<string, unknown> | null {
  const subset: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const dottedPath of paths) {
    const parts = dottedPath.split('.');
    if (parts.length === 0 || parts.some(unsafePathPart)) return null;

    let source: unknown = doc;
    for (const part of parts) {
      if (!source || typeof source !== 'object' || Array.isArray(source) || !Object.hasOwn(source, part)) return null;
      source = (source as Record<string, unknown>)[part];
    }

    let target = subset;
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      if (!target[part]) target[part] = Object.create(null) as Record<string, unknown>;
      target = target[part] as Record<string, unknown>;
    }
    target[parts[parts.length - 1]] = source;
  }
  return subset;
}

function removeManagedJsonPath(doc: Record<string, unknown>, dottedPath: string): boolean {
  const parts = dottedPath.split('.');
  if (parts.length === 0 || parts.some(unsafePathPart)) {
    return false;
  }

  const parents: Array<{ value: Record<string, unknown>; key: string }> = [];
  let current = doc;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i];
    const next = current[key];
    if (!next || typeof next !== 'object' || Array.isArray(next)) return false;
    parents.push({ value: current, key });
    current = next as Record<string, unknown>;
  }

  const leaf = parts[parts.length - 1];
  if (!Object.hasOwn(current, leaf)) return false;
  delete current[leaf];
  for (let i = parents.length - 1; i >= 0; i--) {
    const { value, key } = parents[i];
    const child = value[key];
    if (child && typeof child === 'object' && !Array.isArray(child) && Object.keys(child).length === 0) {
      delete value[key];
    } else {
      break;
    }
  }
  return true;
}

/** True when the file contains only content owned by OpenLore's installer. */
export function isEntirelyOpenLoreManaged(path: string, content: string): boolean {
  if (extname(path).toLowerCase() === '.json') {
    try {
      const parsed = JSON.parse(content) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
      const doc = structuredClone(parsed) as Record<string, unknown>;
      const meta = doc._openlore;
      if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return false;
      const marker = meta as Record<string, unknown>;
      if (
        marker.managed !== true || typeof marker.fingerprint !== 'string' ||
        !Array.isArray(marker.paths) || marker.paths.length === 0 ||
        !marker.paths.every(managedPath => typeof managedPath === 'string')
      ) return false;

      const paths = marker.paths as string[];
      const subset = managedJsonSubset(doc, paths);
      if (!subset || shortHash(canonicalize(subset)) !== marker.fingerprint) return false;

      delete doc._openlore;
      for (const managedPath of paths) {
        if (!removeManagedJsonPath(doc, managedPath)) return false;
      }
      return Object.keys(doc).length === 0;
    } catch {
      return false;
    }
  }

  const begin = content.indexOf(OPENLORE_BLOCK_BEGIN);
  if (begin !== -1) {
    const endMarker = content.indexOf(OPENLORE_BLOCK_END, begin + OPENLORE_BLOCK_BEGIN.length);
    if (endMarker === -1) return false;
    const inner = content.slice(begin + OPENLORE_BLOCK_BEGIN.length, endMarker);
    const fingerprint = inner.match(/<!-- openlore-fingerprint: ([0-9a-f]+) -->/i)?.[1];
    if (!fingerprint) return false;
    const managedContent = inner
      .replace(/<!-- openlore-fingerprint: [0-9a-f]+ -->\n?/i, '')
      .replace(/^\n+/, '')
      .trimEnd();
    if (shortHash(managedContent) !== fingerprint) return false;
    const outside = content.slice(0, begin) + content.slice(endMarker + OPENLORE_BLOCK_END.length);
    return outside.trim().length === 0;
  }

  // Cursor's generated .mdc uses fingerprinted YAML frontmatter instead of block delimiters.
  if (extname(path).toLowerCase() !== '.mdc') return false;
  const mdc = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  const frontmatter = mdc?.[1].split(/\r?\n/).filter(line => line.trim().length > 0) ?? [];
  if (
    frontmatter.length !== 3 ||
    !frontmatter.includes('description: OpenLore orient() workflow') ||
    !frontmatter.includes('alwaysApply: true')
  ) return false;
  const mdcFingerprint = frontmatter
    .map(line => line.match(/^openlore-fingerprint:\s*([0-9a-f]+)\s*$/i)?.[1])
    .find(Boolean);
  const mdcBody = mdc?.[2].replace(/^\r?\n/, '').trimEnd();
  return !!mdcFingerprint && mdcBody !== undefined && shortHash(mdcBody) === mdcFingerprint;
}
