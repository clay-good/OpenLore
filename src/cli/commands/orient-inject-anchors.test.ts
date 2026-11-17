/** The anchor gate of the prompt briefing (change: anchor-gated-prompt-briefing). */
import { describe, expect, it } from 'vitest';
import { INJECTION_DEFAULTS, evaluateRelevanceGate, extractCodeAnchors, keepExactAnchors, userWords, type LeanOrientResult } from './orient-inject-render.js';
import { isOpenSpecProposalInvocation } from './proposal-context.js';

describe('extractCodeAnchors', () => {
  it('finds no code in the process prompts that real sessions are made of', () => {
    for (const prompt of [
      "i've merged. please start group 2, harden, prove it works well, then drive to merge state.",
      'please fix ci on 708',
      'please resolve conflicts on 714 and update 715 again if needed',
      'assume the role of a world class security engineer. please read and fix all security and quality issues in OpenLore',
      'can we maybe include details about how he can set it up and test it himself on GitHub?',
      'Yes, resolve',
    ]) expect(extractCodeAnchors(prompt), prompt).toEqual([]);
  });

  it('finds backticked names, paths, and identifier shapes, in order, deduplicated', () => {
    expect(extractCodeAnchors('why does `detectExistingSpecDir` miss docs/specs in src/core/services/config-manager.ts?'))
      .toEqual(['detectExistingSpecDir', 'src/core/services/config-manager.ts']);
    expect(extractCodeAnchors('CallEdge and FunctionNode both; also handle_request, MAX_RETRIES and Logger.warning() and handleOrient'))
      .toEqual(['CallEdge', 'FunctionNode', 'handle_request', 'MAX_RETRIES', 'Logger.warning', 'handleOrient']);
    expect(extractCodeAnchors('call `run()` twice and edit orient.ts')).toEqual(['run', 'orient.ts']);
  });

  it('caps at 8 and skips brand words', () => {
    expect(extractCodeAnchors('OpenLore on GitHub with TypeScript')).toEqual([]);
    expect(extractCodeAnchors(Array.from({ length: 12 }, (_, i) => `fooBar${i}`).join(' '))).toHaveLength(8);
  });
});

describe('keepExactAnchors', () => {
  const result: LeanOrientResult = {
    task: 'x', searchMode: 'keyword',
    relevantFiles: ['src/auth/mw.ts', 'src/index.ts', 'src/core/services/config-manager.ts'],
    relevantFunctions: [
      { name: 'authMiddleware', filePath: 'src/auth/mw.ts' },
      { name: 'main', filePath: 'src/index.ts', fanIn: 40, isHub: true },
      { name: 'Logger.warning', filePath: 'src/utils/logger.ts' },
      { name: 'readConfig', filePath: 'src/core/services/config-manager.ts' },
    ],
    specDomains: ['auth'],
    callPaths: [{ function: 'authMiddleware', callers: [{ name: 'route' }] }, { function: 'main', callers: [] }],
    regionStyle: { language: 'TypeScript', dominantIdioms: ['arrow'] },
    parseHealth: 'Parse health: src/index.ts parsed with errors.',
  };

  it('keeps only what an anchor names exactly, and drops search neighbours and extras', () => {
    const kept = keepExactAnchors(result, ['authMiddleware', 'warning'])!;
    expect(kept.relevantFunctions!.map(f => f.name)).toEqual(['authMiddleware', 'Logger.warning']);
    expect(kept.relevantFiles).toEqual(['src/auth/mw.ts', 'src/utils/logger.ts']);
    expect(kept.callPaths!.map(p => p.function)).toEqual(['authMiddleware']);
    expect(kept.specDomains).toBeUndefined();
    expect(kept.regionStyle).toBeUndefined();
    expect(kept.parseHealth).toBeUndefined(); // it names a file that is not shown
    expect(kept.task).toBe('authMiddleware, warning');
  });

  it('a path anchor keeps that file and its functions', () => {
    const kept = keepExactAnchors(result, ['services/config-manager.ts'])!;
    expect(kept.relevantFunctions!.map(f => f.name)).toEqual(['readConfig']);
    expect(kept.relevantFiles).toEqual(['src/core/services/config-manager.ts']);
  });

  it('nothing resolving exactly is undefined, never a near match', () => {
    expect(keepExactAnchors(result, ['authMiddle', 'mainLoop', 'src/auth/other.ts'])).toBeUndefined();
  });
});

describe('precision rules', () => {
  it('pasted material is not the request: no anchors and no proposal workflow from it', () => {
    const prompt = "yes let's rework 727 in this direction.\n<pasted_content id=\"9cca\">Write a new OpenSpec change proposal for `OrderService` in src/orders/service.ts</pasted_content>";
    expect(extractCodeAnchors(userWords(prompt))).toEqual([]);
    expect(isOpenSpecProposalInvocation(prompt)).toBe(false);
    expect(isOpenSpecProposalInvocation('/opsx:propose add caching')).toBe(true);
  });

  it('a fixture defining the anchored name is not shown unless a path anchor points into it', () => {
    const r: LeanOrientResult = { relevantFunctions: [{ name: 'GetOrder', filePath: 'src/core/analyzer/fixtures/genproto/demo.pb.go' }], relevantFiles: ['src/core/analyzer/fixtures/genproto/demo.pb.go'] };
    expect(keepExactAnchors(r, ['GetOrder'])).toBeUndefined();
    expect(keepExactAnchors(r, ['fixtures/genproto/demo.pb.go'])!.relevantFunctions!.map(f => f.name)).toEqual(['GetOrder']);
  });

  it('a name defined in more than two files is ambiguous, not an anchor', () => {
    const r: LeanOrientResult = { relevantFunctions: ['a', 'b', 'c'].map(d => ({ name: 'main', filePath: `scripts/${d}.ts` })) };
    expect(keepExactAnchors(r, ['main'])).toBeUndefined();
    expect(keepExactAnchors({ relevantFunctions: r.relevantFunctions!.slice(0, 2) }, ['main'])!.relevantFunctions).toHaveLength(2);
  });
});

describe('an index being published or repaired is not "no index"', () => {
  it('only index-absent states that no index exists; other not-ready states are silent and not errors', () => {
    const verdict = (reason: string) => evaluateRelevanceGate({ error: 'x', notReady: true, reason } as LeanOrientResult, INJECTION_DEFAULTS).reason;
    expect(verdict('index-absent')).toBe('no-graph');
    for (const r of ['index-publish-in-progress', 'index-generation-unavailable', 'index-generation-mismatch', 'index-unreadable', 'graph-unavailable']) {
      expect(verdict(r), r).toBe('index-busy');
    }
    expect(evaluateRelevanceGate({ error: 'boom' } as LeanOrientResult, INJECTION_DEFAULTS).reason).toBe('error');
  });
});

