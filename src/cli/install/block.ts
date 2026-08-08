/**
 * OpenLore managed-block utilities.
 *
 * A "managed block" is a region inside an existing text file (typically Markdown)
 * delimited by canonical comments. Re-running `openlore install` rewrites the
 * block in place. A SHA-256 fingerprint over the canonical content lets us
 * detect hand-edits and refuse to clobber them unless `--force` is passed.
 */

import { createHash } from 'node:crypto';
import {
  OPENLORE_BLOCK_BEGIN,
  OPENLORE_BLOCK_END,
} from '../../utils/openlore-managed-file.js';

export const BLOCK_BEGIN = OPENLORE_BLOCK_BEGIN;
export const BLOCK_END = OPENLORE_BLOCK_END;

const FINGERPRINT_PREFIX = '<!-- openlore-fingerprint: ';
const FINGERPRINT_SUFFIX = ' -->';

export interface ExtractedBlock {
  /** Index of the BEGIN marker in the source file. */
  beginIndex: number;
  /** Index just past the END marker. */
  endIndex: number;
  /** The raw text between BEGIN and END markers (excluding markers themselves). */
  inner: string;
  /** The fingerprint we previously wrote, if present. */
  fingerprint: string | null;
}

export function fingerprint(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex').slice(0, 16);
}

/** Build the full managed block (markers + fingerprint comment + content). */
export function renderBlock(content: string): string {
  const trimmed = content.trimEnd();
  const fp = fingerprint(trimmed);
  return [
    BLOCK_BEGIN,
    `${FINGERPRINT_PREFIX}${fp}${FINGERPRINT_SUFFIX}`,
    trimmed,
    BLOCK_END,
  ].join('\n');
}

export function extractBlock(source: string): ExtractedBlock | null {
  const beginIndex = source.indexOf(BLOCK_BEGIN);
  if (beginIndex === -1) return null;
  const endMarkerIndex = source.indexOf(BLOCK_END, beginIndex + BLOCK_BEGIN.length);
  if (endMarkerIndex === -1) return null;
  const endIndex = endMarkerIndex + BLOCK_END.length;
  const inner = source.slice(beginIndex + BLOCK_BEGIN.length, endMarkerIndex);
  const fpMatch = inner.match(
    /<!-- openlore-fingerprint: ([0-9a-f]+) -->/
  );
  return {
    beginIndex,
    endIndex,
    inner,
    fingerprint: fpMatch ? fpMatch[1] : null,
  };
}

/**
 * Compute the fingerprint of the *current* inner content as it would be if we
 * had written `expectedContent`. Used to decide whether the block on disk
 * still matches what we last wrote.
 */
export function blockMatchesExpected(block: ExtractedBlock, expectedContent: string): boolean {
  if (!block.fingerprint) return false;
  return block.fingerprint === fingerprint(expectedContent.trimEnd());
}

export interface UpsertResult {
  /** The file contents to write back. */
  next: string;
  /** What happened: 'created' (file/block was new), 'updated' (re-rendered), 'noop' (already matched). */
  action: 'created' | 'updated' | 'noop';
}

/**
 * Upsert the managed block in `existing`. If a block exists, replace it; otherwise
 * append. If the existing block's fingerprint matches the new content, do nothing.
 *
 * Caller is responsible for the `--force` / hand-edit check (use `isHandEdited`).
 */
export function upsertBlock(existing: string, content: string): UpsertResult {
  const rendered = renderBlock(content);
  const block = extractBlock(existing);

  if (!block) {
    const sep = existing.length === 0 || existing.endsWith('\n') ? '' : '\n';
    const leading = existing.length === 0 ? '' : '\n';
    return { next: `${existing}${sep}${leading}${rendered}\n`, action: 'created' };
  }

  if (blockMatchesExpected(block, content)) {
    return { next: existing, action: 'noop' };
  }

  const before = existing.slice(0, block.beginIndex);
  const after = existing.slice(block.endIndex);
  return { next: `${before}${rendered}${after}`, action: 'updated' };
}

/**
 * True iff a block exists on disk and its inner contents no longer hash to its
 * fingerprint (i.e. someone edited inside the markers).
 */
export function isHandEdited(block: ExtractedBlock): boolean {
  if (!block.fingerprint) return false;
  const innerWithoutFingerprintLine = block.inner
    .replace(/<!-- openlore-fingerprint: [0-9a-f]+ -->\n?/, '')
    .replace(/^\n+/, '')
    .trimEnd();
  return fingerprint(innerWithoutFingerprintLine) !== block.fingerprint;
}

/**
 * Remove the managed block from `existing`. Returns null if no block was present.
 */
export function removeBlock(existing: string): string | null {
  const block = extractBlock(existing);
  if (!block) return null;
  const before = existing.slice(0, block.beginIndex).replace(/\n+$/, '');
  const after = existing.slice(block.endIndex).replace(/^\n+/, '');
  if (before.length === 0 && after.length === 0) return '';
  if (before.length === 0) return after.endsWith('\n') ? after : after + '\n';
  if (after.length === 0) return before + '\n';
  return `${before}\n\n${after}`;
}
