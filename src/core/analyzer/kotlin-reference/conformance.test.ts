/**
 * Kotlin reference-project conformance (change: add-kotlin-reference-corpus-conformance, #546).
 *
 * One analysis of `fixtures/kotlin-reference/`, then every ledger entry is checked. An asserted
 * entry must hold. A known gap must not hold: a gap that closes fails here until the entry is
 * promoted in the same pull request. Plain `.test.ts`, so the default lane runs it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CAPABILITIES } from '../language-support.js';
import { KOTLIN_CAPABILITY_TARGET, KOTLIN_NEVER_BACKED } from './capability-target.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  KOTLIN_CHANGES, KOTLIN_DOC_MARKERS, KOTLIN_REFERENCE_LEDGER, LEDGER_STATES, ledgerVerdict,
  renderKotlinSupportSection, type LedgerEntry,
} from './ledger.js';
import { analyzeKotlinReference, type KotlinReferenceModel } from './model.js';

let model: KotlinReferenceModel;
let dispose: () => Promise<void>;

beforeAll(async () => {
  ({ model, dispose } = await analyzeKotlinReference());
}, 120_000);

afterAll(async () => { await dispose?.(); });

describe('Kotlin reference ledger', () => {
  it('analyzes the reference project', () => {
    expect(model.nodes.size).toBeGreaterThan(20);
  });

  it.each(KOTLIN_REFERENCE_LEDGER.map(e => [e.id, e] as const))('%s', async (_id, e: LedgerEntry) => {
    const verdict = ledgerVerdict(e.state, await e.holds(model));
    if (verdict === 'regressed') throw new Error(`Asserted fact no longer holds: ${e.fact}`);
    if (verdict === 'promote') {
      throw new Error(`Known gap now holds — promote "${e.id}" to asserted (change ${e.change}): ${e.fact}`);
    }
    expect(verdict).toBe('ok');
  });
});

describe('Kotlin reference ledger: integrity', () => {
  it('has unique ids, a known state, and a known change on every entry', () => {
    const ids = KOTLIN_REFERENCE_LEDGER.map(e => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const e of KOTLIN_REFERENCE_LEDGER) {
      expect(LEDGER_STATES, e.id).toContain(e.state);
      expect(KOTLIN_CHANGES, e.id).toContain(e.change);
      expect(e.fact.length, e.id).toBeGreaterThan(10);
    }
  });

  it('covers every change of the plan with at least one entry', () => {
    const covered = new Set(KOTLIN_REFERENCE_LEDGER.map(e => e.change));
    expect(KOTLIN_CHANGES.filter(c => !covered.has(c))).toEqual([]);
  });

  it('rejects an unknown state and enforces both directions of the rule', () => {
    expect(ledgerVerdict('asserted', true)).toBe('ok');
    expect(ledgerVerdict('asserted', false)).toBe('regressed');
    expect(ledgerVerdict('known-gap', false)).toBe('ok');
    expect(ledgerVerdict('known-gap', true)).toBe('promote');
    expect(ledgerVerdict('maybe', true)).toBe('invalid');
  });
});

describe('Kotlin capability target', () => {
  it('names every capability Kotlin does not back, by the change that will add it', () => {
    const backed = new Set(model.capabilities);
    const missing = CAPABILITIES.filter(c => !backed.has(c));
    const declared = [...Object.keys(KOTLIN_CAPABILITY_TARGET.missing), ...Object.keys(KOTLIN_NEVER_BACKED)].sort();
    expect([...missing].sort()).toEqual(declared);
    for (const change of Object.values(KOTLIN_CAPABILITY_TARGET.missing)) expect(KOTLIN_CHANGES).toContain(change);
  });
});

describe('Kotlin documentation', () => {
  // Regenerate with: npx tsx scripts/render-kotlin-support.ts
  it('the Kotlin section of docs/language-support.md equals the ledger', () => {
    const doc = readFileSync(fileURLToPath(new URL('../../../../docs/language-support.md', import.meta.url)), 'utf-8');
    const start = doc.indexOf(KOTLIN_DOC_MARKERS.start);
    const end = doc.indexOf(KOTLIN_DOC_MARKERS.end);
    expect(start, 'start marker').toBeGreaterThan(-1);
    expect(end, 'end marker').toBeGreaterThan(start);
    expect(doc.slice(start, end + KOTLIN_DOC_MARKERS.end.length)).toBe(renderKotlinSupportSection());
  });
});
