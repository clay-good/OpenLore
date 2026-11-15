/**
 * Spec sources in their fixed order (change: spec-framework-neutrality, design section 2). The
 * order decides which source is named first and which wins when two claim one file. Only sources
 * with an adapter are checked, so `lookedFor` never names a source that was not looked for.
 */
import type { OpenLoreConfig } from '../../types/index.js';
import type { SpecItem, SpecSource, SpecSourceId } from './types.js';
import { openspecSource } from './openspec.js';

export const SPEC_SOURCE_ORDER: readonly SpecSourceId[] = ['openspec', 'spec-kit', 'bmad', 'adr', 'markdown-requirements', 'tests'];

/** The registered adapters, in {@link SPEC_SOURCE_ORDER}. */
export const SPEC_SOURCE_ADAPTERS: readonly SpecSource[] = [openspecSource];

export interface DetectedSpecSources {
  /** Ids of the sources present, in order. */
  found: SpecSourceId[];
  /** Ids of the sources checked, in order. */
  lookedFor: SpecSourceId[];
}

export async function detectSpecSources(root: string, config: OpenLoreConfig | null, adapters: readonly SpecSource[] = SPEC_SOURCE_ADAPTERS): Promise<DetectedSpecSources> {
  const ordered = orderAdapters(adapters);
  const found: SpecSourceId[] = [];
  for (const a of ordered) if ((await a.detect(root, config).catch(() => [])).length) found.push(a.id);
  return { found, lookedFor: ordered.map(a => a.id) };
}

/** Every item of every present source, source by source in order. */
export async function listSpecItems(root: string, config: OpenLoreConfig | null, adapters: readonly SpecSource[] = SPEC_SOURCE_ADAPTERS): Promise<SpecItem[]> {
  const items: SpecItem[] = [];
  for (const a of orderAdapters(adapters)) items.push(...(await a.list(root, config).catch(() => [])));
  return items;
}

function orderAdapters(adapters: readonly SpecSource[]): SpecSource[] {
  return [...adapters].sort((a, b) => SPEC_SOURCE_ORDER.indexOf(a.id) - SPEC_SOURCE_ORDER.indexOf(b.id));
}

export type { SpecItem, SpecItemKind, SpecSource, SpecSourceId } from './types.js';
