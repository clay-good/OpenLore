import { extname } from 'node:path';

export const OPENLORE_BLOCK_BEGIN =
  '<!-- BEGIN OPENLORE (managed — edits inside this block will be overwritten) -->';
export const OPENLORE_BLOCK_END = '<!-- END OPENLORE -->';

function removeManagedJsonPath(doc: Record<string, unknown>, dottedPath: string): boolean {
  const parts = dottedPath.split('.');
  if (parts.length === 0 || parts.some(part => !part || part === '__proto__' || part === 'prototype' || part === 'constructor')) {
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
      if (marker.managed !== true || !Array.isArray(marker.paths) || marker.paths.length === 0) return false;

      delete doc._openlore;
      for (const managedPath of marker.paths) {
        if (typeof managedPath !== 'string' || !removeManagedJsonPath(doc, managedPath)) return false;
      }
      return Object.keys(doc).length === 0;
    } catch {
      return false;
    }
  }

  const begin = content.indexOf(OPENLORE_BLOCK_BEGIN);
  if (begin === -1) return false;
  const endMarker = content.indexOf(OPENLORE_BLOCK_END, begin + OPENLORE_BLOCK_BEGIN.length);
  if (endMarker === -1) return false;
  const outside = content.slice(0, begin) + content.slice(endMarker + OPENLORE_BLOCK_END.length);
  return outside.trim().length === 0;
}
