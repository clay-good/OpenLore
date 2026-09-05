/**
 * Tests for change.ts handlers:
 *   - handleGenerateChangeProposal
 *   - handleAnnotateStory
 *
 * Pure internal functions (riskBadge, buildProposal, buildRiskContextBlock,
 * patchRiskContext) are tested indirectly through the handlers.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { join, resolve } from 'node:path';

// ── Static mocks (hoisted) ────────────────────────────────────────────────────

vi.mock('./utils.js', async () => {
  const { resolve, relative, sep, isAbsolute } = await import('node:path');
  return {
    validateDirectory: vi.fn(async (dir: string) => dir),
    // Portable containment check: `absDir + sep` prefix matching breaks on Windows
    // where a POSIX-style test fixture like '/proj' makes resolve() emit
    // 'C:\proj\…' that can never start with '/proj\'. Compare via a relative path
    // instead — an escape yields '..' segments or an absolute path on any OS.
    safeJoin: vi.fn((absDir: string, filePath: string) => {
      const resolved = resolve(absDir, filePath);
      const rel = relative(resolve(absDir), resolved);
      if (rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) {
        throw new Error(`Path traversal blocked: "${filePath}" resolves outside project directory`);
      }
      return resolved;
    }),
  };
});

vi.mock('./orient.js', () => ({
  handleOrient: vi.fn(async () => ({
    relevantFunctions: [],
    specDomains: [],
    insertionPoints: [],
    matchingSpecs: [],
  })),
}));

vi.mock('./semantic.js', () => ({
  handleSearchSpecs: vi.fn(async () => ({ results: [] })),
}));

vi.mock('./graph.js', () => ({
  handleAnalyzeImpact: vi.fn(async () => ({ error: 'no cache' })),
}));

type AnyFn = (...args: any[]) => any;
const mockFs = {
  mkdir: vi.fn() as ReturnType<typeof vi.fn<AnyFn>>,
  writeFile: vi.fn() as ReturnType<typeof vi.fn<AnyFn>>,
  readFile: vi.fn() as ReturnType<typeof vi.fn<AnyFn>>,
};

vi.mock('node:fs/promises', () => ({
  mkdir: (...args: any[]) => mockFs.mkdir(...args),
  writeFile: (...args: any[]) => mockFs.writeFile(...args),
  readFile: (...args: any[]) => mockFs.readFile(...args),
}));

// ── Imports (after mocks) ─────────────────────────────────────────────────────

import { handleGenerateChangeProposal, handleAnnotateStory } from './change.js';
import { handleOrient } from './orient.js';
import { handleSearchSpecs } from './semantic.js';
import { handleAnalyzeImpact } from './graph.js';

const mockOrient = vi.mocked(handleOrient);
const mockSearchSpecs = vi.mocked(handleSearchSpecs);
const mockImpact = vi.mocked(handleAnalyzeImpact);

// ============================================================================
// handleGenerateChangeProposal
// ============================================================================

describe('handleGenerateChangeProposal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockOrient.mockResolvedValue({ relevantFunctions: [], specDomains: [], insertionPoints: [] });
    mockSearchSpecs.mockResolvedValue({ results: [] });
    mockImpact.mockResolvedValue({ error: 'no cache' });
    mockFs.mkdir.mockResolvedValue(undefined);
    mockFs.writeFile.mockResolvedValue(undefined);
  });

  it('returns error for empty slug', async () => {
    const result = await handleGenerateChangeProposal('/proj', 'Add auth', '   ') as Record<string, unknown>;
    expect(result.error).toMatch(/Invalid slug/);
    expect(mockFs.writeFile).not.toHaveBeenCalled();
  });

  it('returns error for slug with only special chars', async () => {
    const result = await handleGenerateChangeProposal('/proj', 'Add auth', '---!!!') as Record<string, unknown>;
    expect(result.error).toMatch(/Invalid slug/);
  });

  it('normalises slug to lowercase hyphenated', async () => {
    const result = await handleGenerateChangeProposal('/proj', 'desc', 'Add Payment RETRY') as Record<string, unknown>;
    expect(result.slug).toBe('add-payment-retry');
    expect(result.proposalPath).toBe('openspec/changes/add-payment-retry/proposal.md');
  });

  it('writes proposal.md to the correct path', async () => {
    await handleGenerateChangeProposal('/proj', 'Add payment retry', 'add-payment-retry');
    expect(mockFs.mkdir).toHaveBeenCalledWith(
      expect.stringContaining(join('openspec', 'changes', 'add-payment-retry')),
      { recursive: true },
    );
    expect(mockFs.writeFile).toHaveBeenCalledWith(
      expect.stringContaining('proposal.md'),
      expect.any(String),
      'utf8',
    );
  });

  it('calls orient and search_specs in parallel', async () => {
    await handleGenerateChangeProposal('/proj', 'Add retry logic', 'add-retry');
    expect(mockOrient).toHaveBeenCalledWith('/proj', 'Add retry logic', 7);
    expect(mockSearchSpecs).toHaveBeenCalledWith('/proj', 'Add retry logic', 5);
  });

  it('returns riskLevel unknown when orient returns no functions', async () => {
    const result = await handleGenerateChangeProposal('/proj', 'desc', 'my-story') as Record<string, unknown>;
    expect(result.riskLevel).toBe('unknown');
    expect(result.maxRiskScore).toBeNull();
  });

  it('runs impact analysis on top 2 functions from orient', async () => {
    mockOrient.mockResolvedValue({
      relevantFunctions: [
        { name: 'fnA', filePath: 'a.ts', score: 0.9, fanIn: 5, fanOut: 2, isHub: false, linkedSpecs: [] },
        { name: 'fnB', filePath: 'b.ts', score: 0.7, fanIn: 2, fanOut: 1, isHub: false, linkedSpecs: [] },
        { name: 'fnC', filePath: 'c.ts', score: 0.5, fanIn: 1, fanOut: 0, isHub: false, linkedSpecs: [] },
      ],
      specDomains: [],
      insertionPoints: [],
    });
    mockImpact.mockResolvedValue({ symbol: 'fnA', riskScore: 35, riskLevel: 'low' });

    await handleGenerateChangeProposal('/proj', 'desc', 'my-story');

    // Only top 2 functions → 2 impact calls
    expect(mockImpact).toHaveBeenCalledTimes(2);
    expect(mockImpact).toHaveBeenCalledWith('/proj', 'fnA', 2);
    expect(mockImpact).toHaveBeenCalledWith('/proj', 'fnB', 2);
  });

  it('returns correct riskLevel for medium risk', async () => {
    mockOrient.mockResolvedValue({
      relevantFunctions: [
        { name: 'fn', filePath: 'f.ts', score: 1, fanIn: 3, fanOut: 1, isHub: false, linkedSpecs: [] },
      ],
      specDomains: [],
      insertionPoints: [],
    });
    // thresholds: < 40 low, < 70 medium, < 85 high, >= 85 critical
    mockImpact.mockResolvedValue({ symbol: 'fn', riskScore: 40, riskLevel: 'medium' });

    const result = await handleGenerateChangeProposal('/proj', 'desc', 'my-story') as Record<string, unknown>;
    expect(result.riskLevel).toBe('medium');
    expect(result.maxRiskScore).toBe(40);
  });

  it('returns critical riskLevel for score > 70', async () => {
    mockOrient.mockResolvedValue({
      relevantFunctions: [
        { name: 'hub', filePath: 'h.ts', score: 1, fanIn: 20, fanOut: 5, isHub: true, linkedSpecs: [] },
      ],
      specDomains: [],
      insertionPoints: [],
    });
    mockImpact.mockResolvedValue({ symbol: 'hub', riskScore: 85, riskLevel: 'critical' });

    const result = await handleGenerateChangeProposal('/proj', 'desc', 'big-story') as Record<string, unknown>;
    expect(result.riskLevel).toBe('critical');
  });

  it('includes domains and requirements counts in return value', async () => {
    mockOrient.mockResolvedValue({
      relevantFunctions: [],
      specDomains: [
        { domain: 'auth', specFile: 'openspec/specs/auth/spec.md', matchCount: 3 },
        { domain: 'api', specFile: 'openspec/specs/api/spec.md', matchCount: 1 },
      ],
      insertionPoints: [],
    });
    mockSearchSpecs.mockResolvedValue({
      results: [
        { score: 0.9, domain: 'auth', section: '## Auth', title: 'ValidateToken', text: 'token validation', linkedFiles: [] },
        { score: 0.7, domain: 'api', section: '## API', title: 'RateLimit', text: 'rate limit', linkedFiles: [] },
      ],
    });

    const result = await handleGenerateChangeProposal('/proj', 'desc', 'auth-story') as Record<string, unknown>;
    expect(result.domainsAffected).toEqual(['auth', 'api']);
    expect(result.requirementsTouched).toBe(2);
  });

  it('includes storyContent in proposal when provided', async () => {
    await handleGenerateChangeProposal('/proj', 'desc', 'with-story', '## Story\nAs a user…');
    const written = mockFs.writeFile.mock.calls[0][1] as string;
    expect(written).toContain('BMAD story');
    expect(written).toContain('As a user…');
  });

  it('skips impact analysis when orient returns error (non-fatal)', async () => {
    mockOrient.mockResolvedValue({ error: 'no cache' });
    // Should not throw
    const result = await handleGenerateChangeProposal('/proj', 'desc', 'no-cache-story') as Record<string, unknown>;
    expect(result.orientErrors).toEqual(['no cache']);
    expect(mockImpact).not.toHaveBeenCalled();
  });

  it('proposal markdown contains ## Intent section', async () => {
    await handleGenerateChangeProposal('/proj', 'Add retry logic to payment service', 'add-retry');
    const written = mockFs.writeFile.mock.calls[0][1] as string;
    expect(written).toContain('## Intent');
    expect(written).toContain('Add retry logic to payment service');
  });

  it('proposal markdown contains high-risk warning when maxRisk >= 70', async () => {
    mockOrient.mockResolvedValue({
      relevantFunctions: [
        { name: 'hub', filePath: 'h.ts', score: 1, fanIn: 20, fanOut: 5, isHub: true, linkedSpecs: [] },
      ],
      specDomains: [],
      insertionPoints: [],
    });
    mockImpact.mockResolvedValue({ symbol: 'hub', riskScore: 80, riskLevel: 'critical' });

    await handleGenerateChangeProposal('/proj', 'desc', 'risky-story');
    const written = mockFs.writeFile.mock.calls[0][1] as string;
    expect(written).toContain('High risk detected');
  });
});

// ============================================================================
// handleAnnotateStory
// ============================================================================

describe('handleAnnotateStory', () => {
  const STORY_PATH = '/proj/stories/my-story.md';

  const BASE_STORY = `# Story: Add payment retry

## Description
As a user I want payments to retry automatically.

## Acceptance Criteria
- AC1: retry 3 times on failure

## Tasks
- [ ] implement retry logic
`;

  beforeEach(() => {
    vi.clearAllMocks();
    mockOrient.mockResolvedValue({ relevantFunctions: [], specDomains: [], insertionPoints: [] });
    mockImpact.mockResolvedValue({ error: 'no cache' });
    mockFs.readFile.mockResolvedValue(BASE_STORY);
    mockFs.writeFile.mockResolvedValue(undefined);
  });

  it('returns error when story file not found', async () => {
    mockFs.readFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    const result = await handleAnnotateStory('/proj', STORY_PATH, 'Add retry') as Record<string, unknown>;
    expect(result.error).toMatch(/Story file not found/);
    expect(mockFs.writeFile).not.toHaveBeenCalled();
  });

  it('writes back to the same file path', async () => {
    await handleAnnotateStory('/proj', STORY_PATH, 'Add retry');
    // safeJoin resolves against the project dir, so the write target is the
    // OS-native resolved path (identical to STORY_PATH on POSIX).
    expect(mockFs.writeFile).toHaveBeenCalledWith(resolve('/proj', STORY_PATH), expect.any(String), 'utf8');
  });

  it('inserts ## Risk Context before ## Tasks when section absent', async () => {
    await handleAnnotateStory('/proj', STORY_PATH, 'Add retry');
    const written = mockFs.writeFile.mock.calls[0][1] as string;
    const rcIdx = written.indexOf('## Risk Context');
    const tasksIdx = written.indexOf('## Tasks');
    expect(rcIdx).toBeGreaterThan(-1);
    expect(rcIdx).toBeLessThan(tasksIdx);
  });

  it('replaces existing ## Risk Context section body', async () => {
    const storyWithContext = BASE_STORY + `\n## Risk Context\n\n> old content\n\n- **Domains**: old\n`;
    mockFs.readFile.mockResolvedValue(storyWithContext);

    mockOrient.mockResolvedValue({
      relevantFunctions: [],
      specDomains: [{ domain: 'auth', specFile: 'openspec/specs/auth/spec.md', matchCount: 2 }],
      insertionPoints: [],
    });

    await handleAnnotateStory('/proj', STORY_PATH, 'Add auth');
    const written = mockFs.writeFile.mock.calls[0][1] as string;

    // Only one occurrence of the heading
    const occurrences = (written.match(/## Risk Context/g) ?? []).length;
    expect(occurrences).toBe(1);
    // New domain present
    expect(written).toContain('auth');
    // Old content gone
    expect(written).not.toContain('old content');
  });

  it('includes blocking refactor warning when maxRisk >= 70', async () => {
    mockOrient.mockResolvedValue({
      relevantFunctions: [
        { name: 'hub', filePath: 'h.ts', score: 1, fanIn: 20, fanOut: 5, isHub: true, linkedSpecs: [] },
      ],
      specDomains: [],
      insertionPoints: [],
    });
    mockImpact.mockResolvedValue({ symbol: 'hub', riskScore: 75, riskLevel: 'high' });

    await handleAnnotateStory('/proj', STORY_PATH, 'Modify hub');
    const written = mockFs.writeFile.mock.calls[0][1] as string;
    expect(written).toContain('Blocking refactors');
    expect(written).toContain('hub');
  });

  it('returns blocked: true when maxRisk >= 70', async () => {
    mockOrient.mockResolvedValue({
      relevantFunctions: [
        { name: 'hub', filePath: 'h.ts', score: 1, fanIn: 20, fanOut: 5, isHub: true, linkedSpecs: [] },
      ],
      specDomains: [],
      insertionPoints: [],
    });
    // thresholds: < 40 low, < 70 medium, < 85 high, >= 85 critical
    mockImpact.mockResolvedValue({ symbol: 'hub', riskScore: 75, riskLevel: 'high' });

    const result = await handleAnnotateStory('/proj', STORY_PATH, 'desc') as Record<string, unknown>;
    expect(result.blocked).toBe(true);
    expect(result.riskLevel).toBe('high');
  });

  it('returns blocked: false for low risk', async () => {
    mockOrient.mockResolvedValue({
      relevantFunctions: [
        { name: 'fn', filePath: 'f.ts', score: 1, fanIn: 1, fanOut: 1, isHub: false, linkedSpecs: [] },
      ],
      specDomains: [],
      insertionPoints: [],
    });
    mockImpact.mockResolvedValue({ symbol: 'fn', riskScore: 15, riskLevel: 'low' });

    const result = await handleAnnotateStory('/proj', STORY_PATH, 'desc') as Record<string, unknown>;
    expect(result.blocked).toBe(false);
    expect(result.riskLevel).toBe('low');
  });

  it('accepts relative story path (resolved against project dir)', async () => {
    await handleAnnotateStory('/proj', 'stories/my-story.md', 'desc');
    expect(mockFs.readFile).toHaveBeenCalledWith(
      expect.stringContaining(join('stories', 'my-story.md')),
      'utf8',
    );
  });

  it('risk context block contains Auto-generated header', async () => {
    await handleAnnotateStory('/proj', STORY_PATH, 'Add retry');
    const written = mockFs.writeFile.mock.calls[0][1] as string;
    expect(written).toContain('Auto-generated by openlore');
  });

  it('includes insertion point in risk context when orient provides one', async () => {
    mockOrient.mockResolvedValue({
      relevantFunctions: [],
      specDomains: [],
      insertionPoints: [
        { rank: 1, name: 'processPayment', filePath: 'payments.ts', role: 'orchestrator', strategy: 'extend', reason: 'main entry', score: 0.9 },
      ],
    });

    await handleAnnotateStory('/proj', STORY_PATH, 'desc');
    const written = mockFs.writeFile.mock.calls[0][1] as string;
    expect(written).toContain('processPayment');
  });

  it('appends risk context at end of file when no known marker found', async () => {
    const minimalStory = '# Story\n\nSome content.\n';
    mockFs.readFile.mockResolvedValue(minimalStory);

    await handleAnnotateStory('/proj', STORY_PATH, 'desc');
    const written = mockFs.writeFile.mock.calls[0][1] as string;
    expect(written).toContain('## Risk Context');
    expect(written.indexOf('## Risk Context')).toBeGreaterThan(written.indexOf('Some content.'));
  });
});
