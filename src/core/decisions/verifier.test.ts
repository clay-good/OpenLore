/**
 * Tests for decision verifier — LLM call + JSON parsing robustness
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { verifyDecisions, substantiveEvidence } from './verifier.js';
import type { PendingDecision } from '../../types/index.js';
import type { LLMService } from '../services/llm-service.js';

vi.mock('../../utils/logger.js', () => ({
  logger: { warning: vi.fn(), info: vi.fn(), error: vi.fn(), success: vi.fn(), section: vi.fn(), discovery: vi.fn(), analysis: vi.fn(), blank: vi.fn() },
}));

// ============================================================================
// HELPERS
// ============================================================================

function makeLLM(response: string): LLMService {
  return {
    complete: vi.fn().mockResolvedValue({ content: response, model: 'test-model' }),
    completeJSON: vi.fn(),
    saveLogs: vi.fn().mockResolvedValue(undefined),
  } as unknown as LLMService;
}

function makeDecision(overrides: Partial<PendingDecision> = {}): PendingDecision {
  return {
    id: 'aaaa0001',
    status: 'consolidated',
    title: 'Use Redis for caching',
    rationale: 'Reduces DB load',
    consequences: 'Needs cache invalidation',
    proposedRequirement: 'The system SHALL use Redis',
    affectedDomains: ['cache'],
    affectedFiles: ['src/cache.ts'],
    sessionId: 'sess001',
    recordedAt: '2026-01-01T00:00:00.000Z',
    confidence: 'medium',
    syncedToSpecs: [],
    ...overrides,
  };
}

const VALID_RESPONSE = JSON.stringify({
  verified: [{ id: 'aaaa0001', evidenceFile: 'src/cache.ts', confidence: 'high' }],
  phantom: [],
  missing: [],
});

// ============================================================================
// Empty / no-op cases
// ============================================================================

describe('verifyDecisions — empty', () => {
  it('returns empty result when decisions array is empty', async () => {
    const llm = makeLLM(VALID_RESPONSE);
    const result = await verifyDecisions([], 'some diff', llm);
    expect(result.verified).toHaveLength(0);
    expect(result.phantom).toHaveLength(0);
    expect(result.missing).toHaveLength(0);
    expect(llm.complete).not.toHaveBeenCalled();
  });
});

// ============================================================================
// Happy path
// ============================================================================

describe('verifyDecisions — happy path', () => {
  it('marks decisions as verified when LLM confirms', async () => {
    const llm = makeLLM(VALID_RESPONSE);
    const d = makeDecision();
    const result = await verifyDecisions([d], 'diff content', llm);
    expect(result.verified).toHaveLength(1);
    expect(result.verified[0].status).toBe('verified');
    expect(result.verified[0].confidence).toBe('high');
    expect(result.verified[0].verificationEvidence).toBe('git-diff');
    expect(result.verified[0].evidenceFile).toBe('src/cache.ts');
  });

  it('marks decisions as phantom when LLM says phantom', async () => {
    const response = JSON.stringify({ verified: [], phantom: [{ id: 'aaaa0001' }], missing: [] });
    const llm = makeLLM(response);
    const d = makeDecision();
    const result = await verifyDecisions([d], 'diff', llm);
    expect(result.phantom).toHaveLength(1);
    expect(result.phantom[0].status).toBe('phantom');
    expect(result.phantom[0].confidence).toBe('low');
  });

  it('surfaces missing changes from LLM', async () => {
    const response = JSON.stringify({
      verified: [],
      phantom: [],
      missing: [{ file: 'src/auth.ts', description: 'Added JWT middleware without a decision' }],
    });
    const llm = makeLLM(response);
    const d = makeDecision();
    const result = await verifyDecisions([d], 'diff', llm);
    expect(result.missing).toHaveLength(1);
    expect(result.missing[0].file).toBe('src/auth.ts');
  });

  it('silently drops verified entries with unknown IDs', async () => {
    const response = JSON.stringify({
      verified: [{ id: 'unknownid', evidenceFile: 'x.ts', confidence: 'high' }],
      phantom: [],
      missing: [],
    });
    const llm = makeLLM(response);
    const d = makeDecision({ id: 'aaaa0001' });
    const result = await verifyDecisions([d], 'diff', llm);
    expect(result.verified).toHaveLength(0);
  });
});

// ============================================================================
// JSON parsing robustness (H1)
// ============================================================================

describe('verifyDecisions — JSON parsing robustness', () => {
  it('parses plain JSON object', async () => {
    const llm = makeLLM(VALID_RESPONSE);
    const result = await verifyDecisions([makeDecision()], 'diff', llm);
    expect(result.verified).toHaveLength(1);
  });

  it('parses JSON wrapped in ```json ... ``` fences', async () => {
    const fenced = '```json\n' + VALID_RESPONSE + '\n```';
    const llm = makeLLM(fenced);
    const result = await verifyDecisions([makeDecision()], 'diff', llm);
    expect(result.verified).toHaveLength(1);
  });

  it('parses JSON wrapped in plain ``` fences', async () => {
    const fenced = '```\n' + VALID_RESPONSE + '\n```';
    const llm = makeLLM(fenced);
    const result = await verifyDecisions([makeDecision()], 'diff', llm);
    expect(result.verified).toHaveLength(1);
  });

  it('returns empty verified/phantom/missing on completely malformed response', async () => {
    const llm = makeLLM('I cannot determine this.');
    const result = await verifyDecisions([makeDecision()], 'diff', llm);
    expect(result.verified).toHaveLength(0);
    expect(result.phantom).toHaveLength(0);
    expect(result.missing).toHaveLength(0);
  });

  it('returns empty result on invalid JSON inside fences', async () => {
    const llm = makeLLM('```json\nnot json\n```');
    const result = await verifyDecisions([makeDecision()], 'diff', llm);
    expect(result.verified).toHaveLength(0);
  });
});

// ============================================================================
// File-targeted diff (M3)
// ============================================================================

const MULTI_FILE_DIFF = [
  'diff --git a/src/cache.ts b/src/cache.ts\nindex 0000000..1111111 100644\n--- a/src/cache.ts\n+++ b/src/cache.ts\n@@ -1,2 +1,3 @@\n+import Redis from "ioredis";\n export default {};',
  'diff --git a/src/auth.ts b/src/auth.ts\nindex 0000000..2222222 100644\n--- a/src/auth.ts\n+++ b/src/auth.ts\n@@ -1 +1,2 @@\n+export function verifyJWT() {}',
].join('\n');

describe('verifyDecisions — file-targeted diff', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('passes only affected file hunks in the targetedDiff field', async () => {
    const llm = makeLLM(VALID_RESPONSE);
    const d = makeDecision({ affectedFiles: ['src/cache.ts'] });
    await verifyDecisions([d], MULTI_FILE_DIFF, llm);
    const prompt = vi.mocked(llm.complete).mock.calls[0][0].userPrompt as string;
    const parsed = JSON.parse(prompt.replace('Decisions:\n', ''));
    expect(parsed[0].targetedDiff).toContain('src/cache.ts');
    expect(parsed[0].targetedDiff).not.toContain('src/auth.ts');
  });

  it('falls back to global diff slice when no affectedFiles match', async () => {
    const llm = makeLLM(VALID_RESPONSE);
    const d = makeDecision({ affectedFiles: ['src/unknown.ts'] });
    await verifyDecisions([d], MULTI_FILE_DIFF, llm);
    const prompt = vi.mocked(llm.complete).mock.calls[0][0].userPrompt as string;
    const parsed = JSON.parse(prompt.replace('Decisions:\n', ''));
    expect(parsed[0].targetedDiff).toBeTruthy();
  });

  it('includes commit messages in the prompt when provided', async () => {
    const llm = makeLLM(VALID_RESPONSE);
    await verifyDecisions([makeDecision()], MULTI_FILE_DIFF, llm, 'abc1234 add Redis caching');
    const prompt = vi.mocked(llm.complete).mock.calls[0][0].userPrompt as string;
    expect(prompt).toContain('Commit messages:');
    expect(prompt).toContain('add Redis caching');
  });

  it('does not include commit section when commitMessages is absent', async () => {
    const llm = makeLLM(VALID_RESPONSE);
    await verifyDecisions([makeDecision()], MULTI_FILE_DIFF, llm);
    const prompt = vi.mocked(llm.complete).mock.calls[0][0].userPrompt as string;
    expect(prompt).not.toContain('Commit messages:');
  });
});

// ============================================================================
// HF-1: deterministic phantom-rescue fallback
// ============================================================================

// A substantive hunk for src/cache.ts: 2+ changed (+/-) lines.
const SUBSTANTIVE_CACHE_DIFF =
  'diff --git a/src/cache.ts b/src/cache.ts\n' +
  'index 0000000..1111111 100644\n--- a/src/cache.ts\n+++ b/src/cache.ts\n' +
  '@@ -1,2 +1,4 @@\n+import Redis from "ioredis";\n+export const client = new Redis();\n-const old = 1;\n export default {};';

describe('substantiveEvidence', () => {
  it('returns the evidence file when all affected files have substantive hunks', () => {
    const map = new Map([['src/cache.ts', SUBSTANTIVE_CACHE_DIFF]]);
    expect(substantiveEvidence(makeDecision({ affectedFiles: ['src/cache.ts'] }), map)).toBe('src/cache.ts');
  });

  it('returns null when an affected file is absent from the diff', () => {
    const map = new Map([['src/cache.ts', SUBSTANTIVE_CACHE_DIFF]]);
    expect(substantiveEvidence(makeDecision({ affectedFiles: ['src/cache.ts', 'src/other.ts'] }), map)).toBeNull();
  });

  it('returns null when the hunk is below the substantive threshold', () => {
    const trivial = new Map([['src/cache.ts', 'diff --git a/src/cache.ts b/src/cache.ts\n+++ b/src/cache.ts\n+x']]);
    expect(substantiveEvidence(makeDecision({ affectedFiles: ['src/cache.ts'] }), trivial)).toBeNull();
  });

  it('returns null when there are no affected files', () => {
    expect(substantiveEvidence(makeDecision({ affectedFiles: [] }), new Map())).toBeNull();
  });
});

describe('verifyDecisions — HF-1 phantom rescue', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('rescues an LLM-marked phantom whose affected files are demonstrably in the diff', async () => {
    const response = JSON.stringify({ verified: [], phantom: [{ id: 'aaaa0001' }], missing: [] });
    const llm = makeLLM(response);
    const d = makeDecision({ affectedFiles: ['src/cache.ts'] });
    const result = await verifyDecisions([d], SUBSTANTIVE_CACHE_DIFF, llm);
    expect(result.phantom).toHaveLength(0);
    expect(result.verified).toHaveLength(1);
    expect(result.verified[0].status).toBe('verified');
    expect(result.verified[0].confidence).toBe('low');
    expect(result.verified[0].evidenceFile).toBe('src/cache.ts');
  });

  it('leaves a phantom as phantom when its files are not in the diff', async () => {
    const response = JSON.stringify({ verified: [], phantom: [{ id: 'aaaa0001' }], missing: [] });
    const llm = makeLLM(response);
    const d = makeDecision({ affectedFiles: ['src/cache.ts'] });
    const result = await verifyDecisions([d], MULTI_FILE_DIFF.replace(/cache/g, 'nope'), llm);
    expect(result.verified).toHaveLength(0);
    expect(result.phantom).toHaveLength(1);
  });
});
