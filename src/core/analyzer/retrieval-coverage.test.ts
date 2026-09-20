/**
 * The coverage verdict (change: abstain-when-retrieval-is-uncovered).
 *
 * The failure it exists to prevent: on 2026-09-20 an orientation about a spinner that
 * would not stop returned three confidently-ranked symbols, none on the causal path, in
 * the same shape it returns a correct answer. A ranked list of incidental matches is not
 * an answer, and the evidence to tell them apart was already attached to every result.
 */
import { describe, expect, it } from 'vitest';
import {
  QUESTION_KINDS,
  QUESTION_KIND_TOOL,
  coverageDisclosure,
  coverageVerdict,
  isQuestionKind,
  type MatchEvidence,
} from './retrieval-evidence.js';

const evidence = (field: MatchEvidence['field'], tier: MatchEvidence['tier']): MatchEvidence =>
  ({ field, terms: ['spinner'], tier });

describe('coverageVerdict — folded from evidence, never tuned', () => {
  it('is covered when a result matched the caller own terms (tier 1)', () => {
    expect(coverageVerdict([evidence('body', 1)])).toBe('covered');
  });

  it('is covered when a result matched a field that names the thing', () => {
    expect(coverageVerdict([evidence('symbol', 2)])).toBe('covered');
    expect(coverageVerdict([evidence('path', 2)])).toBe('covered');
    expect(coverageVerdict([evidence('signature', 2)])).toBe('covered');
  });

  it('is weak when every result rests on incidental evidence', () => {
    // A vocabulary expansion the caller never typed, body text, and vector proximity.
    expect(coverageVerdict([evidence('body', 2), evidence('doc', 2), evidence('vector', 3)])).toBe('weak');
  });

  it('is weak for a dense-only neighbour with no lexical overlap', () => {
    expect(coverageVerdict([evidence('vector', 3)])).toBe('weak');
  });

  it('is uncovered when nothing matched', () => {
    expect(coverageVerdict([])).toBe('uncovered');
  });

  it('takes the strongest evidence in the set, not the first', () => {
    expect(coverageVerdict([evidence('vector', 3), evidence('body', 2), evidence('symbol', 2)])).toBe('covered');
  });

  it('is a total function of the evidence: same input, same verdict, no configuration', () => {
    const set = [evidence('doc', 2), evidence('vector', 3)];
    expect(coverageVerdict(set)).toBe(coverageVerdict([...set]));
    // The fold takes exactly one argument — there is no threshold to pass in.
    expect(coverageVerdict.length).toBe(1);
  });
});

describe('question kinds — closed vocabulary, honest routing', () => {
  it('keeps the vocabulary closed', () => {
    expect(QUESTION_KINDS).toHaveLength(6);
    expect(isQuestionKind('who-calls')).toBe(true);
    expect(isQuestionKind('how-fast')).toBe(false);
    expect(isQuestionKind(undefined)).toBe(false);
  });

  it('routes a structural question to the tool that answers it', () => {
    const disclosure = coverageDisclosure('uncovered', 'who-calls');
    expect(disclosure.answeredBy).toBe('analyze_impact');
    expect(disclosure.reason).toContain('analyze_impact');
  });

  it('admits the kind no shipped tool answers, offering no substitute', () => {
    expect(QUESTION_KIND_TOOL['what-gates']).toBeNull();
    const disclosure = coverageDisclosure('uncovered', 'what-gates');
    expect(disclosure.answeredBy).toBeUndefined();
    expect(disclosure.reason).toContain('no shipped tool');
  });

  it('explains a weak verdict by what the results rest on', () => {
    const disclosure = coverageDisclosure('weak', 'where-is');
    expect(disclosure.verdict).toBe('weak');
    expect(disclosure.reason).toContain('incidental evidence');
  });

  it('names a tool for every kind that has one, and nothing invented for the rest', () => {
    for (const kind of QUESTION_KINDS) {
      const tool = QUESTION_KIND_TOOL[kind];
      expect(tool === null || typeof tool === 'string').toBe(true);
    }
  });
});
