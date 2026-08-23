/**
 * Spec-09 — static coverage gate (the headline anti-rot guard). Runs in the fast
 * offline suite: adding a tool to TOOL_DEFINITIONS without a driver entry fails
 * CI here, with no network and no analyzed repo required.
 */
import { describe, it, expect } from 'vitest';
import { TOOL_DEFINITIONS } from '../../../../cli/commands/mcp.js';
import { TOOL_REGISTRY, uncoveredTools, staleRegistryEntries, type RepoFacts } from './tool-driver.js';

describe('spec-09 tool-driver coverage gate', () => {
  it('covers every tool in TOOL_DEFINITIONS (no uncovered tool)', () => {
    const uncovered = uncoveredTools();
    expect(
      uncovered,
      uncovered.length
        ? `tool(s) "${uncovered.join('", "')}" have no harness driver entry — add them to TOOL_REGISTRY`
        : 'all covered',
    ).toEqual([]);
  });

  it('has no stale registry entries (every entry maps to a real tool)', () => {
    expect(staleRegistryEntries()).toEqual([]);
  });

  it('registry size equals the tool surface size', () => {
    expect(Object.keys(TOOL_REGISTRY).length).toBe(TOOL_DEFINITIONS.length);
  });
});

describe('spec-09 arg-builders', () => {
  const fullFacts: RepoFacts = {
    directory: '/cache/ts-commander@sha',
    functionName: 'Command',
    secondFunction: 'parse',
    filePath: 'lib/command.js',
    searchTerm: 'option',
    specDomain: undefined,
    decisionId: 'abcd1234',
  };

  it('always sets directory for every drivable tool', () => {
    for (const [name, plan] of Object.entries(TOOL_REGISTRY)) {
      const args = plan.buildArgs(fullFacts);
      if (args !== null) {
        expect(args.directory, name).toBe(fullFacts.directory);
      }
    }
  });

  it('derives function-scoped args from real facts', () => {
    expect(TOOL_REGISTRY.get_subgraph.buildArgs(fullFacts)).toMatchObject({ functionName: 'Command' });
    expect(TOOL_REGISTRY.analyze_impact.buildArgs(fullFacts)).toMatchObject({ symbol: 'Command' });
    expect(TOOL_REGISTRY.trace_execution_path.buildArgs(fullFacts)).toMatchObject({
      entryFunction: 'Command',
      targetFunction: 'parse',
    });
  });

  it('derives query- and file-scoped args from real facts', () => {
    expect(TOOL_REGISTRY.search_code.buildArgs(fullFacts)).toMatchObject({ query: 'option' });
    expect(TOOL_REGISTRY.explain_retrieval_miss.buildArgs(fullFacts)).toMatchObject({
      query: 'option',
      surface: 'code',
      target: { kind: 'symbol', value: 'Command', filePath: 'lib/command.js' },
    });
    expect(TOOL_REGISTRY.orient.buildArgs(fullFacts)).toMatchObject({ task: 'option' });
    expect(TOOL_REGISTRY.get_function_skeleton.buildArgs(fullFacts)).toMatchObject({ filePath: 'lib/command.js' });
  });

  it('returns null (derive-skip) when required facts are missing', () => {
    const bare: RepoFacts = { directory: '/cache/x' };
    expect(TOOL_REGISTRY.get_subgraph.buildArgs(bare)).toBeNull();
    expect(TOOL_REGISTRY.search_code.buildArgs(bare)).toBeNull();
    expect(TOOL_REGISTRY.get_spec.buildArgs(bare)).toBeNull();
    expect(TOOL_REGISTRY.approve_decision.buildArgs(bare)).toBeNull();
    // directory-only tools never derive-skip
    expect(TOOL_REGISTRY.get_architecture_overview.buildArgs(bare)).not.toBeNull();
  });

  it('keeps LLM tools offline-safe where a no-LLM path exists', () => {
    expect(TOOL_REGISTRY.generate_tests.buildArgs(fullFacts)).toMatchObject({ useLlm: false, dryRun: true });
  });
});
