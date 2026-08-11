/**
 * Transport-safe evidence-stream pagination for the spec-workflow composites.
 *
 * A composite response is an ORDERED STREAM of logical evidence records —
 * domain membership, signatures, each inventory family, relationships, spec
 * segments, mapping observations, drift, structural changes, overlaps. A page
 * packs records from the stream until the SERIALIZED envelope approaches the
 * effective byte budget, and the cursor records the stream section plus the
 * offset inside it (change `harden-spec-workflow-lifecycle`, decision c9598b6f).
 *
 * Why bytes and not tokens: tokenizers vary by host and model, so a token
 * estimate cannot guarantee a transport limit. Serialized UTF-8 bytes are the
 * enforcement unit; a token estimate may be reported alongside, never enforced.
 *
 * Why a section+offset cursor and not a file offset: a single oversized file can
 * contribute more signatures or relationships than one page holds. A file-offset
 * cursor would make the remainder of that file's evidence unreachable; a
 * section+offset cursor continues INSIDE the section instead.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** Bumped whenever the cursor payload or packing contract changes. */
export const EVIDENCE_STREAM_PROTOCOL = 1;

/**
 * Default serialized budget: 48 KiB.
 *
 * Every bundled adapter must be able to carry a full page without its own
 * truncation. Pi clips model-visible tool text at 50,000 characters, so the
 * default sits below that boundary with room for the adapter's own framing.
 */
export const DEFAULT_RESPONSE_BYTES = 48 * 1024;

/** Server maximum. A caller may request less, never more. */
export const MAX_RESPONSE_BYTES = 220 * 1024;

/** Floor, so a caller cannot request a budget no page could ever satisfy. */
export const MIN_RESPONSE_BYTES = 8 * 1024;

/** Clamp a caller-supplied budget into the server's range. */
export function clampResponseBytes(value?: number): number {
  if (!Number.isFinite(value)) return DEFAULT_RESPONSE_BYTES;
  return Math.max(MIN_RESPONSE_BYTES, Math.min(Math.floor(value as number), MAX_RESPONSE_BYTES));
}

/** One logical section of the stream: an ordered, independently pageable list. */
export interface EvidenceSection {
  /** Stable section name, as it appears in receipts and cursors. */
  section: string;
  records: unknown[];
}

/**
 * The cursor payload. Short keys keep the encoded cursor small, since it is
 * carried inside the very budget it governs.
 */
export interface EvidenceCursorPayload {
  /** Protocol version. */
  v: number;
  /** Workflow. */
  w: string;
  /** Requested domain. */
  d: string;
  /** Analysis generation identity the page was built from. */
  g: string;
  /** Index into the ordered section list. */
  s: number;
  /** Offset inside that section. */
  o: number;
  /** Effective byte budget bound into the cursor. */
  b: number;
  /** Fingerprint over the fields above, so a forged cursor is rejected. */
  f: string;
}

export interface EvidenceStreamPosition {
  sectionIndex: number;
  offset: number;
}

export interface EvidencePage {
  /** Sections with at least one record on this page, in stream order. */
  included: string[];
  /** Sections wholly or partly deferred, with the number of records deferred. */
  omitted: Array<{ section: string; reason: string; omittedCount: number }>;
  /** Records selected for this page, keyed by section name. */
  records: Record<string, unknown[]>;
  /** Offset each included section started at, so a trim can recompute the cursor. */
  starts: Record<string, number>;
  /** Where the next page resumes. Absent when the stream is exhausted. */
  next?: EvidenceStreamPosition;
  /**
   * Set when one indivisible record cannot fit in an empty page at this budget.
   * The caller must return a typed unrecoverable error rather than silently
   * dropping the record or declaring the workflow complete.
   */
  unrepresentable?: { section: string; offset: number; bytes: number };
}

// ============================================================================
// CURSORS
// ============================================================================

/**
 * Per-process key for the cursor MAC.
 *
 * A plain digest over the payload authenticates nothing: every input is
 * client-visible, so anyone can recompute it and hand back a position the server
 * never issued. Keying it means only this server can mint a cursor.
 *
 * The key lives for the process lifetime and is never persisted, so a cursor does
 * not survive a server restart — the holder gets the same typed "restart
 * preparation" answer as for a stale generation, which is honest and already a
 * supported outcome. It is deliberately not a config value: a shared secret to
 * manage would be a worse trade than re-issuing a short-lived cursor.
 */
const CURSOR_KEY = randomBytes(32);

function cursorFingerprint(payload: Omit<EvidenceCursorPayload, 'f'>): string {
  return createHmac('sha256', CURSOR_KEY)
    .update([payload.v, payload.w, payload.d, payload.g, payload.s, payload.o, payload.b].join('\0'))
    .digest('hex')
    .slice(0, 32);
}

export function encodeEvidenceCursor(payload: Omit<EvidenceCursorPayload, 'f'>): string {
  const full: EvidenceCursorPayload = { ...payload, f: cursorFingerprint(payload) };
  return Buffer.from(JSON.stringify(full)).toString('base64url');
}

/**
 * Decode and authenticate a cursor.
 *
 * Returns `undefined` for anything that is not a well-formed cursor this server
 * issued at this protocol version: a forged, truncated, or hand-edited cursor is
 * rejected rather than partially honored. Binding the budget into the
 * fingerprint also stops a caller from replaying a cursor at a larger budget
 * than the page it continues.
 */
export function decodeEvidenceCursor(value?: string): EvidenceCursorPayload | undefined {
  if (!value) return undefined;
  let parsed: EvidenceCursorPayload;
  try {
    parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as EvidenceCursorPayload;
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object') return undefined;
  if (parsed.v !== EVIDENCE_STREAM_PROTOCOL) return undefined;
  if (typeof parsed.w !== 'string' || typeof parsed.d !== 'string' || typeof parsed.g !== 'string') return undefined;
  if (!Number.isInteger(parsed.s) || parsed.s < 0) return undefined;
  if (!Number.isInteger(parsed.o) || parsed.o < 0) return undefined;
  if (!Number.isInteger(parsed.b) || parsed.b < MIN_RESPONSE_BYTES || parsed.b > MAX_RESPONSE_BYTES) return undefined;
  const { f, ...rest } = parsed;
  if (typeof f !== 'string') return undefined;
  const expected = Buffer.from(cursorFingerprint(rest), 'utf8');
  const actual = Buffer.from(f, 'utf8');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return undefined;
  return parsed;
}

// ============================================================================
// PACKING
// ============================================================================

const byteLength = (value: unknown): number => Buffer.byteLength(JSON.stringify(value) ?? 'null', 'utf8');

/**
 * Pack the stream into one page that fits `budget` serialized bytes.
 *
 * `envelopeBytes` is the size of everything on the page that is NOT stream
 * records — identity, provenance, receipt scaffolding, and a reserve for the
 * continuation cursor. Records are admitted while the running total stays within
 * the budget; the caller performs the exact final measurement and may re-pack at
 * a smaller budget, which is why this stays linear.
 */
export function packEvidenceStream(
  sections: EvidenceSection[],
  start: EvidenceStreamPosition,
  budget: number,
  envelopeBytes: number,
): EvidencePage {
  const page: EvidencePage = { included: [], omitted: [], records: {}, starts: {} };
  let used = envelopeBytes;

  for (let sectionIndex = start.sectionIndex; sectionIndex < sections.length; sectionIndex++) {
    const { section, records } = sections[sectionIndex];
    const from = sectionIndex === start.sectionIndex ? Math.min(start.offset, records.length) : 0;

    // The section key and its array brackets cost bytes even when empty.
    const sectionOverhead = section.length + 6;
    let taken = 0;
    let sectionUsed = 0;

    for (let index = from; index < records.length; index++) {
      const cost = byteLength(records[index]) + 1; // + separator
      if (used + sectionOverhead + sectionUsed + cost > budget) {
        if (taken === 0 && page.included.length === 0) {
          // Nothing has been packed yet and this single record still does not
          // fit: it is indivisible at this budget. Disclose rather than drop.
          page.unrepresentable = { section, offset: index, bytes: cost };
        }
        break;
      }
      sectionUsed += cost;
      taken++;
    }

    if (taken > 0) {
      page.records[section] = records.slice(from, from + taken);
      page.starts[section] = from;
      page.included.push(section);
      used += sectionOverhead + sectionUsed;
    }

    if (from + taken < records.length) {
      page.next = { sectionIndex, offset: from + taken };
      break;
    }
  }

  finalizeOmissions(page, sections);
  return page;
}

/**
 * Recompute `omitted` from the page's continuation position.
 *
 * Derived rather than accumulated, so trimming stays correct: everything at or
 * after `next` is deferred, everything before it was delivered on this page or
 * an earlier one.
 */
function finalizeOmissions(page: EvidencePage, sections: EvidenceSection[]): void {
  page.omitted = [];
  if (!page.next) return;
  const { sectionIndex, offset } = page.next;
  for (let index = sectionIndex; index < sections.length; index++) {
    const { section, records } = sections[index];
    const deferred = index === sectionIndex ? records.length - offset : records.length;
    if (deferred > 0) page.omitted.push({ section, reason: 'response-budget', omittedCount: deferred });
  }
}

/**
 * Trim the last records off a packed page until the EXACT serialized envelope
 * fits the budget, returning the trimmed records to the stream.
 *
 * The packer works from per-record estimates; this is the authoritative check.
 * Returns `false` when even an empty page cannot fit, which is an unrecoverable
 * transport condition for the caller to report.
 */
export function trimPageToBudget(
  page: EvidencePage,
  sections: EvidenceSection[],
  budget: number,
  measure: (page: EvidencePage) => number,
): boolean {
  while (measure(page) > budget) {
    const lastSection = page.included[page.included.length - 1];
    if (!lastSection) return false;

    const records = page.records[lastSection];
    records.pop();
    const sectionIndex = sections.findIndex(entry => entry.section === lastSection);
    page.next = { sectionIndex, offset: page.starts[lastSection] + records.length };

    if (records.length === 0) {
      delete page.records[lastSection];
      delete page.starts[lastSection];
      page.included.pop();
    }
    finalizeOmissions(page, sections);
  }
  return true;
}
