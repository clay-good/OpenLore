/** CLI/MCP conclusion-parity guard (change: bound-standing-context-cost). */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TOOL_OUTPUT_CLASS } from '../../core/services/mcp-handlers/tool-contract.js';
import { TOOL_DEFINITIONS } from './mcp.js';
import { COMMAND_GROUPS } from '../help-groups.js';

type Pair = {
  tool: string;
  command: string;
  commandExport: string;
  cliFile: string;
  commonInputs: readonly string[];
  mcpOnlyInputs?: readonly string[];
  cliOnlyInputs?: readonly string[];
};

const PAIRS: readonly Pair[] = [
  { tool: 'orient', command: 'orient', commandExport: 'orientCommand', cliFile: 'orient.ts', commonInputs: ['directory', 'task', 'limit', 'tokenBudget', 'lean'], mcpOnlyInputs: ['rankBy'] },
  { tool: 'search_code', command: 'search', commandExport: 'searchCommand', cliFile: 'search.ts', commonInputs: ['directory', 'query', 'limit', 'language', 'minFanIn', 'tokenBudget'], mcpOnlyInputs: ['mode'] },
  { tool: 'search_specs', command: 'search', commandExport: 'searchCommand', cliFile: 'search.ts', commonInputs: ['directory', 'query', 'limit', 'domain', 'section'] },
  { tool: 'explain_retrieval_miss', command: 'search', commandExport: 'searchCommand', cliFile: 'search.ts', commonInputs: ['directory', 'query', 'surface', 'target', 'limit', 'language', 'minFanIn', 'domain', 'section'] },
  { tool: 'blast_radius', command: 'blast-radius', commandExport: 'blastRadiusCommand', cliFile: 'blast-radius.ts', commonInputs: ['directory', 'baseRef'], mcpOnlyInputs: ['depth', 'maxSymbols'] },
  { tool: 'change_impact_certificate', command: 'impact-certificate', commandExport: 'impactCertificateCommand', cliFile: 'impact-certificate.ts', commonInputs: ['directory', 'baseRef', 'change', 'persist'], cliOnlyInputs: ['allowBaseFallback'] },
  { tool: 'report_coverage_gaps', command: 'coverage-gaps', commandExport: 'coverageGapsCommand', cliFile: 'coverage-gaps.ts', commonInputs: ['directory', 'maxResults', 'filePattern', 'changedSymbols', 'diffRef'], mcpOnlyInputs: ['directResolvedOnly'] },
  { tool: 'certify_public_surface', command: 'certify-public-surface', commandExport: 'certifyPublicSurfaceCommand', cliFile: 'certify-public-surface.ts', commonInputs: ['directory', 'baseRef', 'maxResults'], cliOnlyInputs: ['allowBaseFallback'] },
  { tool: 'get_style_fingerprint', command: 'style-fingerprint', commandExport: 'styleFingerprintCommand', cliFile: 'style-fingerprint.ts', commonInputs: ['directory', 'communityId', 'filePath', 'language'] },
  { tool: 'briefing_since', command: 'briefing-since', commandExport: 'briefingSinceCommand', cliFile: 'briefing-since.ts', commonInputs: ['directory', 'baseRef', 'filePattern', 'maxResults'] },
  { tool: 'find_clones', command: 'find-clones', commandExport: 'findClonesCommand', cliFile: 'find-clones.ts', commonInputs: ['directory', 'symbol', 'snippet', 'minSimilarity', 'maxResults'] },
  { tool: 'analyze_error_propagation', command: 'error-propagation', commandExport: 'errorPropagationCommand', cliFile: 'error-propagation.ts', commonInputs: ['directory', 'symbol', 'maxDepth'] },
  { tool: 'analyze_env_impact', command: 'env-impact', commandExport: 'envImpactCommand', cliFile: 'env-impact.ts', commonInputs: ['directory', 'name', 'maxDepth'] },
  { tool: 'working_set_context', command: 'working-set', commandExport: 'workingSetCommand', cliFile: 'working-set.ts', commonInputs: ['directory', 'change', 'tokenBudget'] },
  { tool: 'spec_store_status', command: 'spec-store', commandExport: 'specStoreCommand', cliFile: 'spec-store.ts', commonInputs: ['directory'] },
];

const MCP_ONLY_REASON_GROUPS: ReadonlyArray<{ reason: string; tools: readonly string[] }> = [
  {
    reason: 'Available only as an MCP-granular conclusion or inside a broader CLI workflow; there is no identical CLI request/response contract.',
    tools: [
      'analyze_codebase', 'get_architecture_overview', 'prepare_spec_generation',
      'prepare_spec_repair', 'get_refactor_report', 'get_signatures',
      'trace_execution_path', 'get_mapping', 'analyze_impact', 'select_tests',
      'find_dead_code', 'structural_diff', 'get_change_coupling', 'check_architecture',
      'get_low_risk_refactor_candidates', 'get_leaf_functions', 'get_critical_hubs',
      'get_duplicate_report', 'locate_symbol_span', 'get_function_skeleton',
      'get_god_functions', 'check_spec_drift', 'suggest_insertion_points',
      'search_unified', 'list_spec_domains', 'get_spec', 'get_function_body',
      'get_file_dependencies', 'generate_change_proposal', 'annotate_story',
      'get_route_inventory', 'get_middleware_inventory', 'get_schema_inventory',
      'get_ui_component_inventory', 'get_env_vars', 'get_external_packages',
      'audit_spec_coverage', 'generate_tests', 'get_test_coverage',
      'get_minimal_context', 'get_cluster', 'get_landmarks', 'get_map', 'find_path',
      'detect_changes', 'get_health_map', 'get_surprising_connections',
      'get_language_support',
    ],
  },
  {
    reason: 'The CLI exposes a broader lifecycle workflow rather than this MCP operation as a one-to-one conclusion.',
    tools: [
      'record_decision', 'list_decisions', 'approve_decision', 'reject_decision',
      'sync_decisions', 'remember', 'recall', 'verify_claim',
    ],
  },
  {
    reason: 'This interactive coordination or federation conclusion has no CLI command with the same request and response contract.',
    tools: ['federation_status', 'plan_parallel_work', 'map_in_flight_conflicts'],
  },
];

/** Authoritative CLI conclusions that intentionally have no one-to-one MCP contract. */
const CLI_ONLY_CONCLUSIONS: ReadonlyArray<{ command: string; reason: string }> = [
  { command: 'prove', reason: 'Composes several checks into a CLI proof workflow.' },
  { command: 'verify', reason: 'Verifies generated specifications as a CLI workflow.' },
  { command: 'drift', reason: 'Applies CLI severity and exit-code policy to drift findings.' },
  { command: 'doctor', reason: 'Diagnoses installation and repository state outside the tool graph.' },
  { command: 'audit', reason: 'Aggregates repository audit checks and CLI policy.' },
  { command: 'preflight', reason: 'Composes multiple conclusions into one preflight report.' },
  { command: 'review', reason: 'Composes review findings and gate policy for a branch.' },
  { command: 'review-corpus', reason: 'Reviews governance-corpus intent as a CLI workflow.' },
  { command: 'enforce', reason: 'Applies repository enforcement policy and process exit semantics.' },
  { command: 'check-edit', reason: 'Reads the watcher-produced per-edit structural verdict and applies agent-hook exit semantics.' },
  { command: 'change-status', reason: 'Combines OpenSpec lifecycle state with validation output.' },
];

const read = (relative: string): string => readFileSync(join(import.meta.dirname, relative), 'utf8');

function paritySourceErrors(pair: Pair, cliSource: string): string[] {
  const errors: string[] = [];
  if (!cliSource.includes(`dispatchTool('${pair.tool}'`) && !cliSource.includes(`dispatchTool("${pair.tool}"`)) {
    errors.push('CLI does not dispatch the paired MCP tool');
  }
  if (!cliSource.includes(".option('--json")) errors.push('CLI has no JSON conclusion path');
  if (!/JSON\.stringify\((?:result|report)/.test(cliSource)) {
    errors.push('CLI JSON path does not serialize the dispatched conclusion directly');
  }
  return errors;
}

describe('CLI/MCP conclusion delivery parity', () => {
  it('classifies every MCP conclusion as paired or explicitly unpaired', () => {
    const conclusions = Object.entries(TOOL_OUTPUT_CLASS)
      .filter(([, outputClass]) => outputClass === 'conclusion')
      .map(([name]) => name)
      .sort();
    const declared = [...PAIRS.map(({ tool }) => tool), ...MCP_ONLY_REASON_GROUPS.flatMap(({ tools }) => tools)].sort();
    expect(new Set(declared).size, 'a conclusion is declared more than once').toBe(declared.length);
    expect(declared).toEqual(conclusions);
    for (const group of MCP_ONLY_REASON_GROUPS) expect(group.reason.trim()).not.toBe('');
    const liveCommands = new Set(COMMAND_GROUPS.flatMap(({ commands }) => commands));
    const pairedCommands = new Set(PAIRS.map(({ command }) => command));
    for (const entry of CLI_ONLY_CONCLUSIONS) {
      expect(liveCommands.has(entry.command), `${entry.command} is not in the CLI registry`).toBe(true);
      expect(pairedCommands.has(entry.command), `${entry.command} cannot be both paired and CLI-only`).toBe(false);
      expect(entry.reason.trim(), `${entry.command} needs an asymmetry reason`).not.toBe('');
    }
  });

  it('registers every paired CLI and routes its JSON result through MCP dispatch', () => {
    const cliRegistry = read('../index.ts');
    for (const pair of PAIRS) {
      expect(cliRegistry.includes(`program.addCommand(${pair.commandExport})`), `${pair.command} is not registered`).toBe(true);
      expect(paritySourceErrors(pair, read(pair.cliFile)), pair.tool).toEqual([]);
      const definition = TOOL_DEFINITIONS.find(({ name }) => name === pair.tool)!;
      const schemaInputs = Object.keys((definition.inputSchema as { properties?: object }).properties ?? {}).sort();
      expect([...pair.commonInputs, ...(pair.mcpOnlyInputs ?? [])].sort(), `${pair.tool} schema inputs need an explicit projection`).toEqual(schemaInputs);
      for (const cliOnly of pair.cliOnlyInputs ?? []) expect(schemaInputs, `${pair.tool}.${cliOnly} must remain CLI-only`).not.toContain(cliOnly);
    }
  });

  it('rejects wrong dispatch and rewritten output', () => {
    const pair = PAIRS[0];
    expect(paritySourceErrors(pair, "command.option('--json'); const result = await dispatchTool('search_code', {}); console.log(JSON.stringify(result))"))
      .toContain('CLI does not dispatch the paired MCP tool');
    expect(paritySourceErrors(pair, "command.option('--json'); const result = await dispatchTool('orient', {}); console.log(JSON.stringify({ data: result }))"))
      .toContain('CLI JSON path does not serialize the dispatched conclusion directly');
  });
});
