/**
 * A spec source: one written form of intent (OpenSpec, Spec Kit, BMAD, ADR folders, …) that
 * OpenLore can detect and list, read-only (change: spec-framework-neutrality, design section 1).
 * No write, validate, or lifecycle method: every consumer needs only "what intent is written, and
 * where". Richer format-specific functions (the OpenSpec `loadSpecCorpus`, `buildSpecMap`) stay the
 * adapter's implementation and are not part of this interface.
 */
import type { OpenLoreConfig } from '../../types/index.js';

export type SpecSourceId = 'openspec' | 'spec-kit' | 'bmad' | 'adr' | 'markdown-requirements' | 'tests';

export type SpecItemKind = 'requirement' | 'scenario' | 'decision' | 'task' | 'test-intent';

export interface SpecItem {
  /** `<source>:<path-or-group>/<name>`, stable across runs. */
  id: string;
  text: string;
  /** Repository-relative, POSIX separators. */
  file: string;
  /** 1-based. */
  line: number;
  kind: SpecItemKind;
}

export interface SpecSource {
  id: SpecSourceId;
  /** The repository-relative paths that make this source present; `[]` = absent. */
  detect(root: string, config: OpenLoreConfig | null): Promise<string[]>;
  list(root: string, config: OpenLoreConfig | null): Promise<SpecItem[]>;
}
