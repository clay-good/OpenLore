import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';

import {
  DEFAULT_RESPONSE_BYTES,
  EVIDENCE_STREAM_PROTOCOL,
  MAX_RESPONSE_BYTES,
  MIN_RESPONSE_BYTES,
  clampResponseBytes,
  decodeEvidenceCursor,
  encodeEvidenceCursor,
  packEvidenceStream,
  trimPageToBudget,
  type EvidenceSection,
} from './evidence-stream.js';

const record = (size: number, tag = 'x'): { id: string } => ({ id: tag.repeat(size) });

const stream = (spec: Record<string, unknown[]>): EvidenceSection[] =>
  Object.entries(spec).map(([section, records]) => ({ section, records }));

const measure = (page: { records: Record<string, unknown[]> }): number =>
  Buffer.byteLength(JSON.stringify(page.records), 'utf8');

// ============================================================================
// BUDGET
// ============================================================================

describe('clampResponseBytes', () => {
  it('defaults below the Pi model-visible boundary', () => {
    expect(clampResponseBytes()).toBe(DEFAULT_RESPONSE_BYTES);
    expect(DEFAULT_RESPONSE_BYTES).toBeLessThan(50_000);
  });

  it('never grants more than the server maximum', () => {
    expect(clampResponseBytes(10 * 1024 * 1024)).toBe(MAX_RESPONSE_BYTES);
  });

  it('never grants less than a page could satisfy', () => {
    expect(clampResponseBytes(1)).toBe(MIN_RESPONSE_BYTES);
    expect(clampResponseBytes(Number.NaN)).toBe(DEFAULT_RESPONSE_BYTES);
  });
});

// ============================================================================
// CURSORS
// ============================================================================

describe('evidence cursors', () => {
  const payload = {
    v: EVIDENCE_STREAM_PROTOCOL, w: 'generation', d: 'billing', g: 'gen-1',
    s: 2, o: 40, b: DEFAULT_RESPONSE_BYTES,
  };

  it('round-trips a well-formed cursor', () => {
    expect(decodeEvidenceCursor(encodeEvidenceCursor(payload))).toMatchObject(payload);
  });

  it('rejects a hand-edited cursor rather than partly honoring it', () => {
    const decoded = decodeEvidenceCursor(encodeEvidenceCursor(payload))!;
    const forged = Buffer.from(JSON.stringify({ ...decoded, o: 0 })).toString('base64url');
    expect(decodeEvidenceCursor(forged)).toBeUndefined();
  });

  it('rejects a cursor replayed at a larger budget than the page it continues', () => {
    const decoded = decodeEvidenceCursor(encodeEvidenceCursor(payload))!;
    const replayed = Buffer.from(JSON.stringify({ ...decoded, b: MAX_RESPONSE_BYTES })).toString('base64url');
    expect(decodeEvidenceCursor(replayed)).toBeUndefined();
  });

  it('rejects a cursor from another protocol version', () => {
    const other = encodeEvidenceCursor({ ...payload, v: EVIDENCE_STREAM_PROTOCOL + 1 });
    expect(decodeEvidenceCursor(other)).toBeUndefined();
  });

  it('rejects malformed and absent cursors', () => {
    expect(decodeEvidenceCursor(undefined)).toBeUndefined();
    expect(decodeEvidenceCursor('')).toBeUndefined();
    expect(decodeEvidenceCursor('not-base64url!!')).toBeUndefined();
    expect(decodeEvidenceCursor(Buffer.from('[]').toString('base64url'))).toBeUndefined();
  });

  it('cannot be minted by anyone who knows the algorithm', () => {
    // The fingerprint used to be a plain digest over fields the caller controls, so
    // a caller could recompute it for ANY position — including one past the end of
    // the stream, which came back as an empty page stamped `complete`. Keyed now:
    // recomputing the documented digest no longer authenticates.
    const forgedPosition = { ...payload, s: 99 };
    const selfSigned = createHash('sha256')
      .update([forgedPosition.v, forgedPosition.w, forgedPosition.d, forgedPosition.g,
        forgedPosition.s, forgedPosition.o, forgedPosition.b].join('\0'))
      .digest('hex').slice(0, 32);
    const forged = Buffer.from(JSON.stringify({ ...forgedPosition, f: selfSigned })).toString('base64url');
    expect(decodeEvidenceCursor(forged)).toBeUndefined();
  });

  it('rejects an out-of-range budget even with a valid shape', () => {
    const tooSmall = encodeEvidenceCursor({ ...payload, b: MIN_RESPONSE_BYTES - 1 });
    expect(decodeEvidenceCursor(tooSmall)).toBeUndefined();
  });
});

// ============================================================================
// PACKING
// ============================================================================

describe('packEvidenceStream', () => {
  it('packs the whole stream and issues no cursor when it fits', () => {
    const sections = stream({ signatures: [record(10)], relationships: [record(10)] });
    const page = packEvidenceStream(sections, { sectionIndex: 0, offset: 0 }, 10_000, 100);
    expect(page.included).toEqual(['signatures', 'relationships']);
    expect(page.next).toBeUndefined();
    expect(page.omitted).toEqual([]);
  });

  it('continues INSIDE a section rather than making its remainder unreachable', () => {
    const sections = stream({ signatures: Array.from({ length: 50 }, () => record(200)) });
    const page = packEvidenceStream(sections, { sectionIndex: 0, offset: 0 }, 2_000, 100);
    expect(page.next?.sectionIndex).toBe(0);
    expect(page.next!.offset).toBeGreaterThan(0);
    expect(page.next!.offset).toBeLessThan(50);
    expect(page.omitted).toEqual([{ section: 'signatures', reason: 'response-budget', omittedCount: 50 - page.next!.offset }]);
  });

  it('reports every later section as deferred, not as absent', () => {
    const sections = stream({
      signatures: Array.from({ length: 50 }, () => record(200)),
      relationships: [record(10), record(10)],
    });
    const page = packEvidenceStream(sections, { sectionIndex: 0, offset: 0 }, 2_000, 100);
    expect(page.omitted.map(entry => entry.section)).toEqual(['signatures', 'relationships']);
    expect(page.omitted.find(entry => entry.section === 'relationships')?.omittedCount).toBe(2);
  });

  it('does not re-send sections already delivered on an earlier page', () => {
    const sections = stream({ signatures: [record(10)], relationships: [record(10)] });
    const page = packEvidenceStream(sections, { sectionIndex: 1, offset: 0 }, 10_000, 100);
    expect(page.included).toEqual(['relationships']);
    expect(page.records.signatures).toBeUndefined();
    expect(page.omitted).toEqual([]);
  });

  it('exhausts the stream across successive pages with no gaps or repeats', () => {
    const sections = stream({
      a: Array.from({ length: 30 }, (_, i) => ({ i, pad: 'a'.repeat(100) })),
      b: Array.from({ length: 30 }, (_, i) => ({ i, pad: 'b'.repeat(100) })),
    });
    const seen: unknown[] = [];
    let position = { sectionIndex: 0, offset: 0 };
    for (let guard = 0; guard < 100; guard++) {
      const page = packEvidenceStream(sections, position, 1_200, 100);
      for (const section of page.included) seen.push(...page.records[section]);
      if (!page.next) break;
      position = page.next;
    }
    expect(seen).toEqual([...sections[0].records, ...sections[1].records]);
  });

  it('crosses a section boundary mid-page without losing the section head', () => {
    const sections = stream({ a: [record(10), record(10)], b: [record(10)] });
    const page = packEvidenceStream(sections, { sectionIndex: 0, offset: 1 }, 10_000, 100);
    expect(page.records.a).toHaveLength(1);
    expect(page.records.b).toHaveLength(1);
    expect(page.next).toBeUndefined();
  });

  it('discloses an indivisible record instead of silently dropping it', () => {
    const sections = stream({ signatures: [record(20_000)] });
    const page = packEvidenceStream(sections, { sectionIndex: 0, offset: 0 }, MIN_RESPONSE_BYTES, 100);
    expect(page.unrepresentable).toMatchObject({ section: 'signatures', offset: 0 });
    expect(page.included).toEqual([]);
  });

  it('does not call a record indivisible merely because the page was already full', () => {
    const sections = stream({ a: [record(1_000)], b: [record(1_000)] });
    const page = packEvidenceStream(sections, { sectionIndex: 0, offset: 0 }, 1_500, 100);
    expect(page.unrepresentable).toBeUndefined();
    expect(page.next).toMatchObject({ sectionIndex: 1, offset: 0 });
  });

  it('accounts for multibyte UTF-8 by bytes, not by character count', () => {
    const ascii = stream({ a: Array.from({ length: 20 }, () => ({ v: 'x'.repeat(50) })) });
    const emoji = stream({ a: Array.from({ length: 20 }, () => ({ v: '🌍'.repeat(50) })) });
    const asciiPage = packEvidenceStream(ascii, { sectionIndex: 0, offset: 0 }, 1_000, 100);
    const emojiPage = packEvidenceStream(emoji, { sectionIndex: 0, offset: 0 }, 1_000, 100);
    expect(emojiPage.records.a.length).toBeLessThan(asciiPage.records.a.length);
  });

  it('emits an empty final page with no cursor when the cursor lands at the end', () => {
    const sections = stream({ a: [record(10)] });
    const page = packEvidenceStream(sections, { sectionIndex: 0, offset: 1 }, 10_000, 100);
    expect(page.included).toEqual([]);
    expect(page.next).toBeUndefined();
    expect(page.omitted).toEqual([]);
  });
});

// ============================================================================
// EXACT-BOUNDARY TRIM
// ============================================================================

describe('trimPageToBudget', () => {
  it('returns over-budget records to the stream and moves the cursor back', () => {
    const sections = stream({ a: Array.from({ length: 10 }, (_, i) => ({ i, pad: 'a'.repeat(50) })) });
    const page = packEvidenceStream(sections, { sectionIndex: 0, offset: 0 }, 100_000, 0);
    expect(page.next).toBeUndefined();

    const budget = measure(page) - 100;
    expect(trimPageToBudget(page, sections, budget, measure)).toBe(true);
    expect(measure(page)).toBeLessThanOrEqual(budget);
    expect(page.next).toBeDefined();
    expect(page.records.a).toHaveLength(page.next!.offset);
    expect(page.omitted).toEqual([
      { section: 'a', reason: 'response-budget', omittedCount: 10 - page.next!.offset },
    ]);
  });

  it('drops an emptied section from the included list', () => {
    const sections = stream({ a: [{ pad: 'a'.repeat(500) }], b: [{ pad: 'b'.repeat(500) }] });
    const page = packEvidenceStream(sections, { sectionIndex: 0, offset: 0 }, 100_000, 0);
    trimPageToBudget(page, sections, 600, measure);
    expect(page.included).toEqual(['a']);
    expect(page.records.b).toBeUndefined();
    expect(page.next).toMatchObject({ sectionIndex: 1, offset: 0 });
  });

  it('refuses a partial page that would deliver nothing', () => {
    // Trimming can empty a page whose envelope overhead alone nearly fills the
    // budget. The empty page then FITS, and its cursor resumes exactly where the
    // request started — the caller would page forever without progress. It has to
    // come back as unrepresentable instead.
    const sections = stream({ a: [{ pad: 'a'.repeat(400) }, { pad: 'b'.repeat(400) }] });
    const page = packEvidenceStream(sections, { sectionIndex: 0, offset: 0 }, 100_000, 0);
    const emptyEnvelope = measure({ ...page, included: [], records: {}, starts: {} } as typeof page);

    // A budget that an empty page fits but no single record does.
    expect(trimPageToBudget(page, sections, emptyEnvelope + 20, measure)).toBe(false);
  });

  it('still accepts an exhausted stream that is legitimately empty', () => {
    const sections = stream({ a: [record(10)] });
    const page = packEvidenceStream(sections, { sectionIndex: 0, offset: 1 }, 10_000, 100);
    expect(page.next).toBeUndefined();
    expect(trimPageToBudget(page, sections, 10_000, measure)).toBe(true);
  });

  it('reports failure when even an empty page cannot fit', () => {
    const sections = stream({ a: [{ pad: 'a'.repeat(500) }] });
    const page = packEvidenceStream(sections, { sectionIndex: 0, offset: 0 }, 100_000, 0);
    expect(trimPageToBudget(page, sections, 1, measure)).toBe(false);
  });
});
