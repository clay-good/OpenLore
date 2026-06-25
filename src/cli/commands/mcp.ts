/**
 * openlore MCP Server
 *
 * Exposes openlore's static analysis capabilities as Model Context Protocol
 * tools, usable from Cline, Claude Code, or any MCP-compatible AI agent.
 *
 * Transport: stdio (standard for editor-embedded MCP servers)
 *
 * Configuration for Cline / Claude Code:
 *   {
 *     "mcpServers": {
 *       "openlore": {
 *         "command": "node",
 *         "args": ["/path/to/openlore/dist/cli/index.js", "mcp"]
 *       }
 *     }
 *   }
 */

import { createRequire } from 'node:module';
const _require = createRequire(import.meta.url);
const _pkgVersion = (_require('../../../package.json') as { version: string }).version;

import { Command } from 'commander';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  InitializeRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ErrorCode,
  LATEST_PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
} from '@modelcontextprotocol/sdk/types.js';
import {
  validateToolArgs,
  withToolTimeout,
  capStructuredResult,
  classifyToolError,
} from '../../core/services/mcp-handlers/tool-guard.js';

import { sanitizeMcpError, validateDirectory } from '../../core/services/mcp-handlers/utils.js';
import { createTracker, updateTracker, updatePanic, resetPanicOnOrient, getFreshnessSignal, trackerToPanicState } from '../../core/services/mcp-handlers/epistemic-lease.js';
import type { EpistemicTracker } from '../../core/services/mcp-handlers/epistemic-lease.js';
import type { PanicResponseMode } from '../../types/index.js';
import { readPanicState, mutatePanicStateLocked, getPanicSignalText } from '../../core/services/mcp-handlers/panic-response.js';
import { emit } from '../../core/services/telemetry.js';
import { readOpenLoreConfig } from '../../core/services/config-manager.js';
import { MCP_TOOL_MAX_BYTES, LEAN_DEFAULT_PRESET, FULL_PRESET, FULL_PRESET_ALIAS } from '../../constants.js';
import {
  handleGetCallGraph,
  handleGetSubgraph,
  handleAnalyzeImpact,
  handleGetLowRiskRefactorCandidates,
  handleGetLeafFunctions,
  handleGetCriticalHubs,
  handleGetGodFunctions,
  handleGetFileDependencies,
  handleTraceExecutionPath,
} from '../../core/services/mcp-handlers/graph.js';
import {
  handleSearchCode,
  handleSuggestInsertionPoints,
  handleSearchSpecs,
} from '../../core/services/mcp-handlers/semantic.js';
import { dispatchTool, UnknownToolError } from '../../core/services/tool-dispatch.js';
import { ensureServeDaemon, callServeTool, type ServeEndpoint } from '../../core/services/serve-client.js';
import {
  handleAnalyzeCodebase,
  handleGetArchitectureOverview,
  handleGetRefactorReport,
  handleGetDuplicateReport,
  handleGetSignatures,
  handleGetMapping,
  handleCheckSpecDrift,
  handleGetFunctionSkeleton,
  handleGetRouteInventory,
  handleGetMiddlewareInventory,
  handleGetSchemaInventory,
  handleGetUIComponents,
  handleGetEnvVars,
  handleGetExternalPackages,
  handleAuditSpecCoverage,
  handleGenerateTests,
  handleGetTestCoverage,
  handleGetMinimalContext,
  handleGetCluster,
  handleDetectChanges,
} from '../../core/services/mcp-handlers/analysis.js';

// Re-export utilities for tests
export { sanitizeMcpError, validateDirectory };

// Re-export handlers for use by chat-tools.ts and tests
export {
  handleGetCallGraph,
  handleGetSubgraph,
  handleAnalyzeImpact,
  handleGetLowRiskRefactorCandidates,
  handleGetLeafFunctions,
  handleGetCriticalHubs,
  handleGetGodFunctions,
  handleGetFileDependencies,
  handleTraceExecutionPath,
  handleSearchCode,
  handleSuggestInsertionPoints,
  handleSearchSpecs,
  handleAnalyzeCodebase,
  handleGetArchitectureOverview,
  handleGetRefactorReport,
  handleGetDuplicateReport,
  handleGetSignatures,
  handleGetMapping,
  handleCheckSpecDrift,
  handleGetFunctionSkeleton,
  handleGetRouteInventory,
  handleGetMiddlewareInventory,
  handleGetSchemaInventory,
  handleGetUIComponents,
  handleGetEnvVars,
  handleGetExternalPackages,
  handleAuditSpecCoverage,
  handleGenerateTests,
  handleGetTestCoverage,
  handleGetMinimalContext,
  handleGetCluster,
  handleDetectChanges,
};

// ============================================================================
// TOOL DEFINITIONS
// ============================================================================

// Spec 28 — the `directory` param is the one input every tool shares (50×). Its
// description was a verbatim 38-char repeat on each tool; a single short shared
// constant trims that lossless repeat from the cached tools/list prefix without
// dropping the one fact that matters (it must be absolute, not relative).
const DIR_DESC = 'Absolute project path';

// Optional federation scope, shared by the four federation-aware conclusion tools
// (analyze_impact, select_tests, find_dead_code, find_path). Inert unless an
// `.openlore/federation.json` registry exists (built via `openlore federation add`),
// so the default surface registers no active cross-repo behavior.
// (change: add-multi-repo-federation)
const FEDERATION_PROPS = {
  federation: {
    type: 'boolean',
    description: 'Opt-in: compute across federated repos (.openlore/federation.json); no-op without a registry (default false).',
  },
  federationRepos: {
    type: 'array',
    items: { type: 'string' },
    description: 'Limit federation scope to these registry repo names (default: all).',
  },
} as const;

export const TOOL_DEFINITIONS = [
  {
    name: 'orient',
    description:
      'START HERE. Call this before any other tool when beginning a new task on an unfamiliar codebase. ' +
      'Given a natural-language task description, returns in ONE call: relevant functions, source files, ' +
      'spec domains that cover them, depth-1 call neighbours, top insertion point candidates, ' +
      'and matching spec sections. Falls back to keyword search if the embedding server is down. ' +
      'Requires "openlore analyze" to have been run at least once.',
    inputSchema: {
      type: 'object',
      properties: {
        directory: {
          type: 'string',
          description: DIR_DESC,
        },
        task: {
          type: 'string',
          description: 'Natural language description of the task, e.g. "add rate limiting to the HTTP API"',
        },
        limit: {
          type: 'number',
          description: 'Number of relevant functions to return (default: 5)',
        },
        tokenBudget: {
          type: 'number',
          description: 'Optional: cap relevantFunctions to ~this many tokens (highest-scored kept, exact duplicates collapsed); each item carries an `expand` handle for get_function_body',
        },
        lean: {
          type: 'boolean',
          description: 'Return only the navigation core (relevantFunctions + callPaths + specDomains); drop provenance/change-coupling/insertion-points/specs/decisions enrichment (each reachable via expand handles or dedicated tools). Lower per-call cost for shallow "who/where" lookups.',
        },
        rankBy: {
          type: 'string',
          enum: ['distance', 'pagerank'],
          description: 'Opt-in landmark ordering (default "distance"). "pagerank" orders task-scoped landmarks by personalized PageRank seeded on the matched functions — connectivity-weighted relevance, not just nearest distance. Default output unchanged.',
        },
      },
      required: ['directory', 'task'],
    },
  },
  {
    name: 'analyze_codebase',
    description:
      'USE THIS WHEN: the project has never been analyzed, or the user says the code changed ' +
      'significantly since the last run, or other tools return "no cache found". ' +
      'Builds the call graph, dependency graph, and refactor priorities — all without an LLM. ' +
      'Results are cached for 1 hour; skip this if the cache is recent.',
    inputSchema: {
      type: 'object',
      properties: {
        directory: {
          type: 'string',
          description: 'Absolute path to the project directory to analyze',
        },
        force: {
          type: 'boolean',
          description: 'Force re-analysis even if a recent cache exists (default: false)',
        },
      },
      required: ['directory'],
    },
  },
  {
    name: 'get_architecture_overview',
    description:
      'USE THIS WHEN: onboarding to an unknown codebase, or before planning a large feature. ' +
      'Returns domain clusters, cross-cluster dependencies, global entry points, and critical hubs. ' +
      'Run analyze_codebase first.',
    inputSchema: {
      type: 'object',
      properties: {
        directory: {
          type: 'string',
          description: 'Absolute path to the project directory (must have been analyzed first)',
        },
      },
      required: ['directory'],
    },
  },
  {
    name: 'get_refactor_report',
    description:
      'Return a prioritized list of functions that need refactoring, based on ' +
      'the cached static analysis. Issues detected: unreachable code, high fan-in ' +
      '(hub overload), high fan-out (god function), SRP violations (multi-requirement), ' +
      'and cyclic dependencies. Run analyze_codebase first.',
    inputSchema: {
      type: 'object',
      properties: {
        directory: {
          type: 'string',
          description: 'Absolute path to the project directory (must have been analyzed first)',
        },
      },
      required: ['directory'],
    },
  },
  {
    name: 'get_call_graph',
    description:
      'Return the call graph for a project: hub functions (high fan-in), ' +
      'entry points (no internal callers), and architectural layer violations. ' +
      'Run analyze_codebase first.',
    inputSchema: {
      type: 'object',
      properties: {
        directory: {
          type: 'string',
          description: DIR_DESC,
        },
      },
      required: ['directory'],
    },
  },
  {
    name: 'get_duplicate_report',
    description:
      'Detect duplicate code (clone groups) across the codebase using pure static analysis. ' +
      'Detects Type 1 (exact clones — identical after whitespace/comment normalization), ' +
      'Type 2 (structural clones — same structure with renamed variables), and ' +
      'Type 3 (near-clones with Jaccard similarity ≥ 0.7 on token n-grams). ' +
      'Run analyze_codebase first.',
    inputSchema: {
      type: 'object',
      properties: {
        directory: {
          type: 'string',
          description: 'Absolute path to the project directory (must have been analyzed first)',
        },
      },
      required: ['directory'],
    },
  },
  {
    name: 'get_signatures',
    description:
      'Return compact function and class signatures for files in a project. ' +
      'Useful for understanding a codebase\'s public API without reading full source. ' +
      'Optionally filter by file path pattern. Run analyze_codebase first.',
    inputSchema: {
      type: 'object',
      properties: {
        directory: {
          type: 'string',
          description: DIR_DESC,
        },
        filePattern: {
          type: 'string',
          description:
            'Optional substring to filter file paths (e.g. "services", "api", ".py")',
        },
      },
      required: ['directory'],
    },
  },
  {
    name: 'get_subgraph',
    description:
      'Extract a subgraph of the call graph centred on ONE specific function. ' +
      'Call once per function — do not combine multiple function names in a single call. ' +
      'Useful for impact analysis ("what does X call?"), dependency tracing ' +
      '("who calls X?"), or understanding a change\'s blast radius. ' +
      'Prefer maxDepth 1 or 2; depth ≥ 3 on large projects may timeout. ' +
      'Run analyze_codebase first.',
    inputSchema: {
      type: 'object',
      properties: {
        directory: {
          type: 'string',
          description: DIR_DESC,
        },
        functionName: {
          type: 'string',
          description: 'Name of a single function to centre the subgraph on (exact name preferred; partial substring also accepted)',
        },
        direction: {
          type: 'string',
          enum: ['downstream', 'upstream', 'both'],
          description:
            'downstream = what this function calls (default), ' +
            'upstream = who calls this function, ' +
            'both = full neighbourhood',
        },
        maxDepth: {
          type: 'number',
          description: 'Maximum traversal depth (default: 3, recommended: 1–2 to avoid timeout)',
        },
        format: {
          type: 'string',
          enum: ['json', 'mermaid'],
          description: 'Output format: "json" (default) or "mermaid" flowchart diagram',
        },
        directResolvedOnly: {
          type: 'boolean',
          description: 'Traverse only directly-resolved edges, ignoring synthesized dynamic-dispatch edges (default false).',
        },
      },
      required: ['directory', 'functionName'],
    },
  },
  {
    name: 'trace_execution_path',
    description:
      'USE THIS WHEN debugging: "how does request X reach function Y?", ' +
      '"which call chain produced this error?", "is there a path from A to B?". ' +
      'Finds all execution paths between two functions in the call graph (BFS/DFS, ' +
      'shortest first). Complementary to get_subgraph — use get_subgraph for ' +
      'neighbourhood exploration, trace_execution_path for point-to-point tracing.',
    inputSchema: {
      type: 'object',
      properties: {
        directory: {
          type: 'string',
          description: DIR_DESC,
        },
        entryFunction: {
          type: 'string',
          description: 'Starting function name (exact or partial match)',
        },
        targetFunction: {
          type: 'string',
          description: 'Target function name (exact or partial match)',
        },
        maxDepth: {
          type: 'number',
          description: 'Maximum path length in hops (default: 6)',
        },
        maxPaths: {
          type: 'number',
          description: 'Maximum number of paths to return (default: 10, max: 50)',
        },
        directResolvedOnly: {
          type: 'boolean',
          description: 'Traverse only directly-resolved edges, ignoring synthesized dynamic-dispatch edges (default false).',
        },
        valueLevel: {
          type: 'boolean',
          description: 'Opt-in: restrict the first hop to calls data-dependent on a value via the def-use overlay; falls back to function granularity (default false).',
        },
        valueParam: {
          type: 'string',
          description: 'Entry parameter/variable to trace (with valueLevel; omit = all params).',
        },
      },
      required: ['directory', 'entryFunction', 'targetFunction'],
    },
  },
  {
    name: 'get_mapping',
    description:
      'Return the requirement → function mapping produced by openlore generate. ' +
      'Shows which functions implement which spec requirements, confidence level ' +
      '(llm / heuristic), and orphan functions not covered by any requirement. ' +
      'Requires openlore generate to have been run at least once.',
    inputSchema: {
      type: 'object',
      properties: {
        directory: {
          type: 'string',
          description: DIR_DESC,
        },
        domain: {
          type: 'string',
          description: 'Filter by domain name (e.g. "auth", "crawler")',
        },
        orphansOnly: {
          type: 'boolean',
          description: 'Return only orphan functions (not covered by any requirement)',
        },
      },
      required: ['directory'],
    },
  },
  {
    name: 'check_spec_drift',
    description:
      'USE THIS WHEN: you\'ve modified code and want to know if the specs are still aligned, ' +
      'or when asked "is the code in sync with the spec?", "what changed since the last spec run?". ' +
      'Compares git-changed files against spec coverage — impossible to replicate by reading files. ' +
      'Requires openlore generate to have been run at least once. No LLM required.',
    inputSchema: {
      type: 'object',
      properties: {
        directory: {
          type: 'string',
          description: 'Absolute path to the project directory (must be a git repository)',
        },
        base: {
          type: 'string',
          description: 'Git ref to compare against (default: auto-detect main/master)',
        },
        files: {
          type: 'array',
          items: { type: 'string' },
          description: 'Specific files to check (default: all changed files)',
        },
        domains: {
          type: 'array',
          items: { type: 'string' },
          description: 'Only check these spec domains (default: all domains)',
        },
        failOn: {
          type: 'string',
          enum: ['error', 'warning', 'info'],
          description: 'Minimum severity to report (default: "warning")',
        },
        maxFiles: {
          type: 'number',
          description: 'Maximum number of changed files to analyze (default: 100)',
        },
      },
      required: ['directory'],
    },
  },
  {
    name: 'analyze_impact',
    description:
      'USE THIS WHEN: you\'re about to modify a function and want to know the full consequences — ' +
      '"what breaks if I change X?", "what\'s the blast radius of modifying Y?". ' +
      'Returns fan-in/out, full call chains, risk score (0–100), and refactoring strategy. ' +
      'Call this before touching any non-trivial function. Run analyze_codebase first.',
    inputSchema: {
      type: 'object',
      properties: {
        directory: {
          type: 'string',
          description: DIR_DESC,
        },
        symbol: {
          type: 'string',
          description: 'Function or method name to analyse (exact or partial match)',
        },
        depth: {
          type: 'number',
          description: 'Traversal depth for upstream/downstream chains (default: 2)',
        },
        directResolvedOnly: {
          type: 'boolean',
          description: 'Traverse only directly-resolved edges, ignoring synthesized dynamic-dispatch edges (default false).',
        },
        valueLevel: {
          type: 'boolean',
          description: 'Opt-in: narrow downstream to calls data-dependent on a value via the def-use overlay; falls back to function granularity (default false).',
        },
        valueParam: {
          type: 'string',
          description: 'Parameter/variable to trace (with valueLevel; omit = all params).',
        },
        ...FEDERATION_PROPS,
      },
      required: ['directory', 'symbol'],
    },
  },
  {
    name: 'select_tests',
    description:
      'USE THIS WHEN: you changed code and want to know which tests to run — ' +
      '"which tests cover parseConfig?", "what should I run for this diff?". ' +
      'Walks the call graph BACKWARD from the change to every test that transitively reaches it, ' +
      'with the reaching path per test. Deterministic, offline, no test run. ' +
      'It is an over-approximate PRIORITIZER (run these first), not a sound replacement for the full ' +
      'suite — the response states its confidence and coverage. Run analyze_codebase first.',
    inputSchema: {
      type: 'object',
      properties: {
        directory: { type: 'string', description: DIR_DESC },
        changedSymbols: {
          type: 'array',
          items: { type: 'string' },
          description: 'Changed function/method names. Optional — if neither this nor diffRef is given, defaults to your current working-tree changes vs HEAD.',
        },
        diffRef: {
          type: 'string',
          description: 'Git ref to diff the working tree against (e.g. "HEAD", "main"). Optional — defaults to HEAD when neither this nor changedSymbols is given.',
        },
        maxDepth: { type: 'number', description: 'Backward reachability depth (default 12)' },
        directResolvedOnly: { type: 'boolean', description: 'Traverse only directly-resolved edges, ignoring synthesized dynamic-dispatch edges (default false).' },
        ...FEDERATION_PROPS,
      },
      required: ['directory'],
    },
  },
  {
    name: 'blast_radius',
    description:
      'USE THIS WHEN: before committing/editing, you want one briefing of what your diff actually ' +
      'touches — "what is the blast radius of my changes?", "is this change safe to commit?". ' +
      'Composes existing deterministic analyses over the staged/working diff into a single ' +
      'conclusion-shaped briefing: affected callers and layers crossed (analyze_impact), the tests ' +
      'to run (select_tests), the anchored memories/decisions the diff will turn drifted/orphaned and ' +
      'the specs it will make stale (check_spec_drift). No LLM, no new analysis — pure orchestration. ' +
      'Advisory: it informs, you act. Run analyze_codebase first.',
    inputSchema: {
      type: 'object',
      properties: {
        directory: { type: 'string', description: DIR_DESC },
        baseRef: { type: 'string', description: 'Git ref to diff the working tree against (e.g. "HEAD", "main"). Default HEAD (uncommitted changes).' },
        depth: { type: 'number', description: 'Impact-analysis traversal depth (default 2).' },
        maxSymbols: { type: 'number', description: 'Cap on the number of highest-fan-in changed symbols analyzed for impact (default 12). Truncation is reported.' },
      },
      required: ['directory'],
    },
  },
  {
    name: 'find_dead_code',
    description:
      'USE THIS WHEN: "what code is unreachable / dead?", "is anything calling X?", or ' +
      '"what becomes dead if I delete X?". Cross-language mark-and-sweep reachability from roots ' +
      '(tests, imported symbols, route handlers, main) over the call graph. ' +
      'Pass ifDeleted to get the downstream-only-reachable set for a symbol. ' +
      'Results are confidence-tagged CANDIDATES, never deletion authority — dynamic dispatch, DI, ' +
      'and external consumers cause false positives, stated in the response. Run analyze_codebase first.',
    inputSchema: {
      type: 'object',
      properties: {
        directory: { type: 'string', description: DIR_DESC },
        ifDeleted: { type: 'string', description: 'Symbol name — returns what becomes dead if it is deleted (delete-impact mode)' },
        maxResults: { type: 'number', description: 'Max candidate-dead results (default 100)' },
        filePattern: { type: 'string', description: 'Only report candidates whose file path contains this substring' },
        directResolvedOnly: { type: 'boolean', description: 'Restrict reachability to directly-resolved edges, ignoring synthesized dynamic-dispatch edges — strict certainty over completeness (default false).' },
        ...FEDERATION_PROPS,
      },
      required: ['directory'],
    },
  },
  {
    name: 'verify_claim',
    description:
      'USE THIS BEFORE asserting a structural fact ("X is dead", "Y calls Z", "this is safe to change") ' +
      'or citing a decision ("ADR abc12345 governs this"). ' +
      'Returns a deterministic verdict (confirmed | refuted | unverifiable) + a citation receipt (spans, ' +
      'content hashes, index commit) — a graph computation, never an LLM guess. kinds: calls, reaches, ' +
      'impacts, dead, safe-to-change (structural); decision-current (is a recorded decision still ' +
      'authoritative, or superseded/rejected?). "unverifiable" is first-class when the claim hits a ' +
      'dynamic-dispatch blind spot or names an unknown decision — hedge or read the source. Run ' +
      'analyze_codebase first for structural kinds.',
    inputSchema: {
      type: 'object',
      properties: {
        directory: { type: 'string', description: DIR_DESC },
        kind: {
          type: 'string',
          enum: ['calls', 'reaches', 'dead', 'impacts', 'safe-to-change', 'decision-current'],
          description: 'The kind of claim to verify (structural, or decision-current for decision authority).',
        },
        subject: { type: 'string', description: 'What the claim is about: a function/method name for structural kinds, or an 8-character decision id for decision-current.' },
        object: { type: 'string', description: 'The second symbol — required for relational kinds (calls, reaches, impacts).' },
      },
      required: ['directory', 'kind', 'subject'],
    },
  },
  {
    name: 'structural_diff',
    description:
      'USE THIS WHEN reviewing or refactoring a change: "what changed structurally?", ' +
      '"whose callers are now stale?". A graph diff (complement to git diff) between two states ' +
      '(working tree vs a ref, or two refs): functions/edges added & removed, signature changes, ' +
      'and the existing callers now STALE because a callee signature moved under them. ' +
      'Rename/move ambiguity is flagged, not guessed. Deterministic, offline. Run analyze_codebase ' +
      'first for stale-caller analysis. Opt-in escape check: pass declaredFootprint to also flag ' +
      'symbols modified OUTSIDE the declared write-set and conflicts they open against peerFootprints.',
    inputSchema: {
      type: 'object',
      properties: {
        directory: { type: 'string', description: DIR_DESC },
        baseRef: { type: 'string', description: 'Old state to diff against (default "HEAD")' },
        headRef: { type: 'string', description: 'New state (a git ref). Omit to use the working tree.' },
        maxResults: { type: 'number', description: 'Cap reported items per category (default 200)' },
        declaredFootprint: {
          type: 'object',
          description:
            'OPT-IN escape check: the task\'s declared write-footprint (a plan_parallel_work `Footprint`). ' +
            'Shape { taskId?, writeSet: [{ id:"file::name", filePath?, writeMode?:append|modify }], readSet?:string[] }. ' +
            'Adds an `escapeAnalysis` block; omit = unchanged behavior.',
          properties: {
            taskId: { type: 'string' },
            writeSet: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  filePath: { type: 'string' },
                  writeMode: { type: 'string', enum: ['append', 'modify'] },
                },
                required: ['id'],
              },
            },
            readSet: { type: 'array', items: { type: 'string' } },
          },
        },
        peerFootprints: {
          type: 'array',
          description:
            'Declared footprints of OTHER in-flight tasks (same shape as declaredFootprint). An escape ' +
            'landing in a peer\'s write-set opens a newly-reported conflict naming that peer.',
          items: { type: 'object' },
        },
      },
      required: ['directory'],
    },
  },
  {
    name: 'get_change_coupling',
    description:
      'USE THIS WHEN: "what changes together with this file?" or "what is the most volatile code?". ' +
      'Mined from local git history (not the call graph): co-change coupling surfaces invisible ' +
      'coupling with no import/call edge (the config + parser that move in lockstep), and ' +
      'volatility/churn flags risky high-change code. Pass a file for its coupling, or omit for the ' +
      'most-volatile overview. Advisory signal (correlation, not causation); bulk commits filtered. ' +
      'Run analyze_codebase first.',
    inputSchema: {
      type: 'object',
      properties: {
        directory: { type: 'string', description: DIR_DESC },
        file: { type: 'string', description: 'A file to query its coupling/volatility. Omit for the most-volatile overview.' },
        limit: { type: 'number', description: 'Cap results (default 20)' },
      },
      required: ['directory'],
    },
  },
  {
    name: 'check_architecture',
    description:
      'USE THIS BEFORE adding an import to check it against the repo\'s architecture rules, or to ' +
      'list current architecture violations. Opt-in and inert unless the repo declares rules in ' +
      '.openlore/architecture.json (layers / forbidden / allowedOnly) or via an "Invariant:" marker ' +
      'in a synced ADR. Pre-edit mode: pass {from, to} ("may a file under <from> import <to>?") for a ' +
      'deterministic allowed/denied + the governing rule + why, BEFORE you write the code. Scan mode: ' +
      'pass only {directory} for the full current-violations report. Cross-language, offline, ' +
      'deterministic; complements (does not replace) CI linters. Run analyze_codebase first.',
    inputSchema: {
      type: 'object',
      properties: {
        directory: { type: 'string', description: DIR_DESC },
        from: { type: 'string', description: 'Pre-edit mode: the file that would gain the import (relative or absolute). Requires "to".' },
        to: { type: 'string', description: 'Pre-edit mode: the target file path or exported symbol being imported. Requires "from".' },
      },
      required: ['directory'],
    },
  },
  {
    name: 'get_low_risk_refactor_candidates',
    description:
      'Return the safest functions to refactor first: low fan-in (few callers), ' +
      'low fan-out (few dependencies), no cyclic involvement, not a hub. ' +
      'Ideal starting point for incremental, low-risk refactoring sessions. ' +
      'Run analyze_codebase first.',
    inputSchema: {
      type: 'object',
      properties: {
        directory: {
          type: 'string',
          description: DIR_DESC,
        },
        limit: {
          type: 'number',
          description: 'Maximum number of candidates to return (default: 5)',
        },
        filePattern: {
          type: 'string',
          description: 'Optional substring to restrict candidates to matching file paths',
        },
      },
      required: ['directory'],
    },
  },
  {
    name: 'get_leaf_functions',
    description:
      'Return functions that make no internal calls (leaves of the call graph). ' +
      'These are the safest refactoring targets: self-contained, easy to unit-test, ' +
      'zero downstream blast radius. Best entry point for bottom-up refactoring. ' +
      'Run analyze_codebase first.',
    inputSchema: {
      type: 'object',
      properties: {
        directory: {
          type: 'string',
          description: DIR_DESC,
        },
        limit: {
          type: 'number',
          description: 'Maximum number of results to return (default: 20)',
        },
        filePattern: {
          type: 'string',
          description: 'Optional substring to restrict results to matching file paths',
        },
        sortBy: {
          type: 'string',
          enum: ['fanIn', 'name', 'file'],
          description:
            'Sort order: "fanIn" (most-called leaves first, default), "name", or "file"',
        },
      },
      required: ['directory'],
    },
  },
  {
    name: 'get_critical_hubs',
    description:
      'Return the highest-impact hub functions: high fan-in (many callers depend on them), ' +
      'possibly high fan-out (god functions). These require the most careful, incremental ' +
      'refactoring with broad test coverage. Includes a stability score and recommended ' +
      'approach (extract, split, facade, delegate). Run analyze_codebase first.',
    inputSchema: {
      type: 'object',
      properties: {
        directory: {
          type: 'string',
          description: DIR_DESC,
        },
        limit: {
          type: 'number',
          description: 'Maximum number of hubs to return (default: 10)',
        },
        minFanIn: {
          type: 'number',
          description: 'Minimum fan-in threshold to be considered a hub (default: 3)',
        },
      },
      required: ['directory'],
    },
  },
  {
    name: 'get_function_skeleton',
    description:
      'Return a noise-stripped skeleton of a source file: logs, inline comments, and ' +
      'non-JSDoc block comments are removed while signatures, control flow (if/for/try), ' +
      'return/throw statements, and call expressions are preserved. ' +
      'Use this before refactoring a god function to get a compact structural view ' +
      'without reading thousands of lines of raw source.',
    inputSchema: {
      type: 'object',
      properties: {
        directory: {
          type: 'string',
          description: DIR_DESC,
        },
        filePath: {
          type: 'string',
          description: 'Path to the file, relative to the project directory',
        },
      },
      required: ['directory', 'filePath'],
    },
  },
  {
    name: 'get_god_functions',
    description:
      'Detect god functions (high fan-out, likely orchestrators) in the project or in a ' +
      'specific file, and return their call-graph neighborhood. ' +
      'Use this to identify which functions need to be refactored and understand what ' +
      'logical blocks to extract. Run analyze_codebase first.',
    inputSchema: {
      type: 'object',
      properties: {
        directory: {
          type: 'string',
          description: DIR_DESC,
        },
        filePath: {
          type: 'string',
          description: 'Optional: restrict search to this file (relative path)',
        },
        fanOutThreshold: {
          type: 'number',
          description: 'Minimum fan-out to be considered a god function (default: 8)',
        },
      },
      required: ['directory'],
    },
  },
  {
    name: 'suggest_insertion_points',
    description:
      'USE THIS WHEN: you need to find where to implement a new feature — ' +
      '"where should I add rate limiting?", "where\'s the best place to add email validation?". ' +
      'Combines semantic search + call graph to return ranked candidates with strategy. ' +
      'Call this before writing any code; then use get_subgraph on the top candidates. ' +
      'Requires "openlore analyze --embed".',
    inputSchema: {
      type: 'object',
      properties: {
        directory: {
          type: 'string',
          description: DIR_DESC,
        },
        description: {
          type: 'string',
          description:
            'Natural language description of the feature to implement, ' +
            'e.g. "add retry mechanism for HTTP requests" or "validate user email on registration"',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of candidates to return (default: 5)',
        },
        language: {
          type: 'string',
          description: 'Filter by language: "TypeScript", "Python", "Go", "Rust", "Ruby", "Java"',
        },
      },
      required: ['directory', 'description'],
    },
  },
  {
    name: 'search_code',
    description:
      'USE THIS WHEN: you don\'t know which file or function handles a concept — ' +
      '"where is rate limiting implemented?", "which function validates tokens?", ' +
      '"what handles authentication?". Beats grep when the function name is unknown. ' +
      'Falls back to keyword search if the embedding server is down, and to a ' +
      'literal-text index on zero hits so strings in markup/text are still found ' +
      '(mode:"text" forces it). ' +
      'Requires "openlore analyze --embed" to have been run at least once.',
    inputSchema: {
      type: 'object',
      properties: {
        directory: {
          type: 'string',
          description: DIR_DESC,
        },
        query: {
          type: 'string',
          description: 'Natural language query, e.g. "authenticate user with JWT"',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of results to return (default: 10)',
        },
        language: {
          type: 'string',
          description: 'Filter by language: "TypeScript", "Python", "Go", "Rust", "Ruby", "Java"',
        },
        minFanIn: {
          type: 'number',
          description: 'Only return functions with at least this many callers (hub filter)',
        },
        tokenBudget: {
          type: 'number',
          description: 'Optional: cap results to ~this many tokens (highest-scored kept, exact duplicates collapsed); each hit carries an `expand` handle for get_function_body',
        },
        mode: {
          type: 'string',
          enum: ['text'],
          description: 'Set "text" to search literal strings in markup/text directly; returns file:line matches.',
        },
      },
      required: ['directory', 'query'],
    },
  },
  {
    name: 'list_spec_domains',
    description:
      'List all OpenSpec domains available in this project. ' +
      'Use this first when you need to discover what domains exist before doing a targeted search_specs call.',
    inputSchema: {
      type: 'object',
      properties: {
        directory: { type: 'string', description: DIR_DESC },
      },
      required: ['directory'],
    },
  },
  {
    name: 'search_specs',
    description:
      'USE THIS WHEN: asked "which spec covers X?", "what does the spec say about Y?", ' +
      '"which requirement describes Z?". Searches specs by meaning and returns linked source files. ' +
      'Use spec-first: check what the spec says before reading or writing code. ' +
      'Requires "openlore analyze --embed" or "openlore analyze --reindex-specs".',
    inputSchema: {
      type: 'object',
      properties: {
        directory: {
          type: 'string',
          description: DIR_DESC,
        },
        query: {
          type: 'string',
          description: 'Natural language query, e.g. "email validation workflow"',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of results to return (default: 10)',
        },
        domain: {
          type: 'string',
          description: 'Filter by domain name (e.g. "auth", "analyzer")',
        },
        section: {
          type: 'string',
          description: 'Filter by section type: "requirements", "purpose", "design", "architecture", "entities"',
        },
      },
      required: ['directory', 'query'],
    },
  },
  {
    name: 'search_unified',
    description:
      'USE THIS WHEN: you want to find where something is implemented AND what the spec says about it ' +
      'in a single call. Searches both code functions and spec requirements simultaneously, then ' +
      'cross-boosts results that are linked through mapping.json — so a function that implements a ' +
      'matching requirement ranks higher than one found by code search alone. ' +
      'Returns results with type "code", "spec", or "both" and a mappingBoost score. ' +
      'Requires "openlore analyze --embed" and a prior "openlore generate" run.',
    inputSchema: {
      type: 'object',
      properties: {
        directory: {
          type: 'string',
          description: DIR_DESC,
        },
        query: {
          type: 'string',
          description: 'Natural language query, e.g. "validate user authentication"',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of results to return (default: 10)',
        },
        language: {
          type: 'string',
          description: 'Filter code results by language (e.g. "TypeScript")',
        },
        domain: {
          type: 'string',
          description: 'Filter spec results by domain name',
        },
        section: {
          type: 'string',
          description: 'Filter spec results by section type: "requirements", "purpose", etc.',
        },
      },
      required: ['directory', 'query'],
    },
  },
  {
    name: 'get_spec',
    description:
      'Return the full content of a spec domain\'s specification file (spec.md) and the ' +
      'functions that implement it. Use this to read requirements directly when you know the ' +
      'domain name. Complements search_specs (which searches by meaning) by giving exact ' +
      'read access to a known domain.',
    inputSchema: {
      type: 'object',
      properties: {
        directory: { type: 'string', description: DIR_DESC },
        domain: {
          type: 'string',
          description: 'Domain name as returned by list_spec_domains (e.g. "auth", "analyzer")',
        },
      },
      required: ['directory', 'domain'],
    },
  },
  {
    name: 'get_function_body',
    description:
      'Return the exact source code of a named function in a file. ' +
      'Use this after search_code or get_function_skeleton to read the full implementation. ' +
      'Requires a prior "openlore analyze" run for precise byte-range extraction; ' +
      'falls back to a brace-depth scan when the call graph is unavailable.',
    inputSchema: {
      type: 'object',
      properties: {
        directory: { type: 'string', description: DIR_DESC },
        filePath: {
          type: 'string',
          description: 'File path relative to the project directory, e.g. "src/auth/jwt.ts"',
        },
        functionName: {
          type: 'string',
          description: 'Name of the function to extract, e.g. "verifyToken"',
        },
      },
      required: ['directory', 'filePath', 'functionName'],
    },
  },
  {
    name: 'get_file_dependencies',
    description:
      'Return the file-level import dependencies for a given source file. ' +
      'Answers "what does this file import?" and "what files import this file?". ' +
      'Useful for planning refactors, understanding coupling, or scoping the blast radius ' +
      'of a change. Reads the dependency-graph.json produced by "openlore analyze".',
    inputSchema: {
      type: 'object',
      properties: {
        directory: { type: 'string', description: DIR_DESC },
        filePath: {
          type: 'string',
          description: 'File path relative to the project root, e.g. "src/core/analyzer/vector-index.ts"',
        },
        direction: {
          type: 'string',
          enum: ['imports', 'importedBy', 'both'],
          description: '"imports" = what this file depends on, "importedBy" = what depends on this file, "both" = both directions (default)',
        },
      },
      required: ['directory', 'filePath'],
    },
  },
  {
    name: 'generate_change_proposal',
    description:
      'USE THIS WHEN: you have a BMAD story, a feature description, or a spec delta request, ' +
      'and want to create a structured OpenSpec change proposal before writing any code. ' +
      'Combines orient + search_specs + analyze_impact to produce a pre-filled ' +
      'openspec/changes/{slug}/proposal.md — no LLM required. ' +
      'Output includes affected domains, touched requirements, risk scores, and insertion points. ' +
      'Run analyze_codebase first; spec index optional (degrades gracefully).',
    inputSchema: {
      type: 'object',
      properties: {
        directory: {
          type: 'string',
          description: DIR_DESC,
        },
        description: {
          type: 'string',
          description:
            'Intent of the change — story title + primary AC, or a free-form feature description. ' +
            'e.g. "add retry logic to payment processing — must retry up to 3 times on timeout"',
        },
        slug: {
          type: 'string',
          description:
            'Change identifier used as the directory name, e.g. "add-payment-retry". ' +
            'Will be lowercased and hyphenated automatically.',
        },
        storyContent: {
          type: 'string',
          description:
            'Optional: full BMAD story content (markdown). If provided, it is embedded verbatim ' +
            'in the proposal for traceability.',
        },
      },
      required: ['directory', 'description', 'slug'],
    },
  },
  {
    name: 'annotate_story',
    description:
      'USE THIS WHEN: you have a BMAD story file and want to auto-populate its risk_context ' +
      'section with structural analysis from the codebase. ' +
      'Reads the story file, runs orient + analyze_impact, writes the risk_context block ' +
      'directly into the file (replaces existing section or inserts it). ' +
      'Run by the Architect Agent after writing stories — eliminates manual copy-paste of ' +
      'generate_change_proposal output. Run analyze_codebase first.',
    inputSchema: {
      type: 'object',
      properties: {
        directory: {
          type: 'string',
          description: DIR_DESC,
        },
        storyFilePath: {
          type: 'string',
          description:
            'Path to the BMAD story markdown file — relative to the project directory ' +
            'or absolute. e.g. ".bmad-method/stories/001-add-payment-retry.md"',
        },
        description: {
          type: 'string',
          description:
            'Story intent for structural analysis — use story title + primary AC. ' +
            'e.g. "add payment retry — must retry up to 3 times on timeout"',
        },
      },
      required: ['directory', 'storyFilePath', 'description'],
    },
  },
  {
    name: 'get_route_inventory',
    description:
      'Return the full HTTP/API route inventory for the project: total count, breakdown by ' +
      'HTTP method and framework, and the list of individual routes with method, path, ' +
      'framework, source file, and handler name. ' +
      'Reads the pre-computed route-inventory.json artifact when available (runs in < 1 ms), ' +
      'otherwise scans source files live. ' +
      'Supports Express, Hono, Fastify, NestJS, Next.js App Router, FastAPI, Flask, Django, and more. ' +
      'Run analyze_codebase first for the fastest results.',
    inputSchema: {
      type: 'object',
      properties: {
        directory: { type: 'string', description: DIR_DESC },
      },
      required: ['directory'],
    },
  },
  {
    name: 'get_middleware_inventory',
    description:
      'Return the middleware inventory for the project: all detected middleware entries with ' +
      'type (auth, cors, rate-limit, validation, logging, error-handler, custom), framework, ' +
      'source file, line number, and name. ' +
      'Reads the pre-computed middleware-inventory.json artifact when available, ' +
      'otherwise scans source files live. ' +
      'Supports Express, Hono, Fastify, NestJS, Next.js, and more. ' +
      'Run analyze_codebase first for the fastest results.',
    inputSchema: {
      type: 'object',
      properties: {
        directory: { type: 'string', description: DIR_DESC },
      },
      required: ['directory'],
    },
  },
  {
    name: 'get_schema_inventory',
    description:
      'Return the database schema inventory for the project: all detected ORM model/table ' +
      'definitions with their fields, types, and nullability. ' +
      'Reads the pre-computed schema-inventory.json artifact when available, ' +
      'otherwise scans source files live. ' +
      'Supports Prisma, TypeORM, Drizzle ORM, and SQLAlchemy. ' +
      'Run analyze_codebase first for the fastest results.',
    inputSchema: {
      type: 'object',
      properties: {
        directory: { type: 'string', description: DIR_DESC },
      },
      required: ['directory'],
    },
  },
  {
    name: 'get_ui_components',
    description:
      'Return the UI component inventory for the project: all detected components with ' +
      'their framework, props, source file, and line number. ' +
      'Reads the pre-computed ui-inventory.json artifact when available, ' +
      'otherwise scans source files live. ' +
      'Supports React, Vue, Svelte, and Angular. ' +
      'Run analyze_codebase first for the fastest results.',
    inputSchema: {
      type: 'object',
      properties: {
        directory: { type: 'string', description: DIR_DESC },
      },
      required: ['directory'],
    },
  },
  {
    name: 'get_env_vars',
    description:
      'Return all environment variables referenced in the project: names, which files use them, ' +
      'whether they have a known default (from .env.example), and whether they are required ' +
      '(used without a fallback in source code). ' +
      'Reads the pre-computed env-inventory.json artifact when available, ' +
      'otherwise scans source files live. ' +
      'Supports JS/TS (process.env), Python (os.environ/os.getenv), Go (os.Getenv), Ruby (ENV[]). ' +
      'Run analyze_codebase first for the fastest results.',
    inputSchema: {
      type: 'object',
      properties: {
        directory: { type: 'string', description: DIR_DESC },
      },
      required: ['directory'],
    },
  },
  {
    name: 'get_external_packages',
    description:
      'Return all direct external dependencies declared in package manifests: ' +
      'package.json (npm), pyproject.toml / requirements.txt (pypi), Cargo.toml (cargo), go.mod (go). ' +
      'Each entry includes name, version, ecosystem, and isDev flag. ' +
      'Reads the pre-computed external-packages.json artifact when available, ' +
      'otherwise scans manifests live. Run analyze_codebase first for the fastest results.',
    inputSchema: {
      type: 'object',
      properties: {
        directory: { type: 'string', description: DIR_DESC },
      },
      required: ['directory'],
    },
  },
  {
    name: 'audit_spec_coverage',
    description:
      'Parity audit: report spec coverage gaps without any LLM call. ' +
      'Returns uncovered functions (exist in call graph but have no spec), ' +
      'hub gaps (high fan-in functions with no spec), ' +
      'orphan requirements (spec requirements with no mapped implementation), ' +
      'and stale domains (source files changed after spec was last written). ' +
      'Use this before starting a new feature to understand what needs specs, ' +
      'or to audit coverage health. Requires "openlore analyze" to have been run.',
    inputSchema: {
      type: 'object',
      properties: {
        directory: { type: 'string', description: DIR_DESC },
        maxUncovered: {
          type: 'number',
          description: 'Maximum uncovered functions to return (default: 50)',
        },
        hubThreshold: {
          type: 'number',
          description: 'Minimum fanIn to flag a function as a hub gap (default: 5)',
        },
      },
      required: ['directory'],
    },
  },
  {
    name: 'generate_tests',
    description:
      'Generate spec-driven test files from OpenSpec scenarios. ' +
      'Supports vitest, playwright (JS/TS), pytest (Python), gtest and catch2 (C++), ' +
      'junit (Java/Kotlin) and gotest (Go). ' +
      'A THEN clause pattern engine emits real assertions for common patterns ' +
      '(HTTP status codes, property presence, error messages) without any LLM call. ' +
      'Pass useLlm:true to enrich unmatched clauses using mapped function source. ' +
      'Each generated test is tagged with a parseable openlore: metadata comment ' +
      'that enables spec coverage tracking via get_test_coverage. ' +
      'Defaults to dryRun:true — set dryRun:false to write files to disk.',
    inputSchema: {
      type: 'object',
      properties: {
        directory: {
          type: 'string',
          description: DIR_DESC,
        },
        domains: {
          type: 'array',
          items: { type: 'string' },
          description: 'Only generate tests for these spec domains (omit for all)',
        },
        framework: {
          type: 'string',
          enum: ['vitest', 'playwright', 'pytest', 'gtest', 'catch2', 'junit', 'gotest', 'auto'],
          description: 'Test framework (default: auto-detect from project files)',
        },
        useLlm: {
          type: 'boolean',
          description: 'Use LLM to fill in assertions the pattern engine cannot match',
        },
        dryRun: {
          type: 'boolean',
          description: 'Preview generated content without writing files (default: true)',
        },
      },
      required: ['directory'],
    },
  },
  {
    name: 'get_test_coverage',
    description:
      'Report which OpenSpec scenarios have corresponding test coverage. ' +
      'Scans test files for // openlore: {JSON} or # openlore: {JSON} metadata tags ' +
      '(added automatically by generate_tests). ' +
      'Returns coverage percentage by domain, a list of uncovered scenarios, ' +
      'and flags domains where spec drift was detected. ' +
      'Use minCoverage to enforce a CI coverage gate.',
    inputSchema: {
      type: 'object',
      properties: {
        directory: {
          type: 'string',
          description: DIR_DESC,
        },
        domains: {
          type: 'array',
          items: { type: 'string' },
          description: 'Only check these spec domains (omit for all)',
        },
        minCoverage: {
          type: 'number',
          description: 'Report belowThreshold:true if effective coverage is below this percentage',
        },
      },
      required: ['directory'],
    },
  },
  {
    name: 'get_minimal_context',
    description:
      'Return the minimum context needed to safely modify a function: ' +
      'its signature and body, direct callers (signatures only), direct callees (signatures only), ' +
      'and which test files cover it. ' +
      'Use this instead of orient when you already know exactly which function to modify. ' +
      'Typically 200-600 tokens vs orient\'s 2000+. Run analyze_codebase first.',
    inputSchema: {
      type: 'object',
      properties: {
        directory: { type: 'string', description: DIR_DESC },
        functionName: { type: 'string', description: 'Exact function or method name' },
        filePath: {
          type: 'string',
          description: 'Optional relative file path to disambiguate when multiple functions share the name',
        },
        rankBy: {
          type: 'string',
          enum: ['distance', 'pagerank'],
          description: 'Opt-in caller/callee ordering (default "distance"). "pagerank" orders neighbours by personalized PageRank seeded on the target and attaches a per-neighbour `relevance`. Default output unchanged.',
        },
        tokenBudget: {
          type: 'number',
          description: 'Optional (pagerank mode): cap callers+callees to ~this many tokens, keeping highest-relevance neighbours and reporting `omittedForBudget` instead of truncating.',
        },
      },
      required: ['directory', 'functionName'],
    },
  },
  {
    name: 'get_cluster',
    description:
      'Return all functions in the same community as the given function. ' +
      'Communities are computed via label propagation on the call graph at analyze time — ' +
      'tightly coupled functions land in the same cluster regardless of directory. ' +
      'Use this to understand the "blast radius neighbourhood" without traversing the graph manually. ' +
      'Run analyze_codebase first.',
    inputSchema: {
      type: 'object',
      properties: {
        directory: { type: 'string', description: DIR_DESC },
        functionName: { type: 'string', description: 'Function name to look up the community for' },
      },
      required: ['directory', 'functionName'],
    },
  },
  {
    name: 'get_landmarks',
    description:
      'Whole-repo structural anchors as LABELED signals with evidence: the union of ' +
      'hub/orchestrator/chokepoint/volatile/entrypoint/dead (each per-signal tool exposes only one). ' +
      'Each function carries its earned labels + raw evidence (e.g. hub:{fanIn}); no blended score — ' +
      'rank as your task needs. Optionally filter to one label. Run analyze_codebase first.',
    inputSchema: {
      type: 'object',
      properties: {
        directory: { type: 'string', description: DIR_DESC },
        limit: { type: 'number', description: 'Max landmarks to return, ordered by fan-in (default: 20, max: 200)' },
        label: { type: 'string', description: 'Optional: return only landmarks carrying this label (hub | orchestrator | chokepoint | volatile | entrypoint | dead)' },
      },
      required: ['directory'],
    },
  },
  {
    name: 'get_map',
    description:
      'The lay of the land: a coarse-to-fine map of the call graph. With no communityId, returns the ' +
      'REGION view — each code community as a super-node (label, size, top files, top landmark) plus ' +
      'weighted inter-region connections, no function bodies — so you can see where regions connect ' +
      'without reading any code. Pass a communityId to drill into one region at function granularity. ' +
      'Run analyze_codebase first.',
    inputSchema: {
      type: 'object',
      properties: {
        directory: { type: 'string', description: DIR_DESC },
        communityId: { type: 'string', description: 'Optional: drill into this region (a communityId from the region view) at function granularity' },
      },
      required: ['directory'],
    },
  },
  {
    name: 'find_path',
    description:
      'Find the route from A to B in the call graph. `from`/`to` may be exact/fuzzy function names ' +
      'OR selectors: landmark:<id>, role:entrypoint|hub|sink, file:<path>. Returns the single ' +
      'CHEAPEST path (by call-distance, or fewest hops if useCallDistance=false) plus a few bounded ' +
      'alternates and a reason — not a raw multi-path dump. "No path within budget" is an explicit ' +
      'answer. Run analyze_codebase first.',
    inputSchema: {
      type: 'object',
      properties: {
        directory: { type: 'string', description: DIR_DESC },
        from: { type: 'string', description: 'Start endpoint: a function name, or landmark:<id> / role:entrypoint|hub|sink / file:<path>' },
        to: { type: 'string', description: 'Goal endpoint: a function name, or landmark:<id> / role:entrypoint|hub|sink / file:<path>' },
        useCallDistance: { type: 'boolean', description: 'Rank by confidence-weighted call-distance (default true); false ranks by fewest hops' },
        directResolvedOnly: { type: 'boolean', description: 'Traverse only directly-resolved edges, ignoring synthesized dynamic-dispatch edges (default false).' },
        ...FEDERATION_PROPS,
      },
      required: ['directory', 'from', 'to'],
    },
  },
  {
    name: 'federation_status',
    description:
      'Report the multi-repo federation registry (.openlore/federation.json) and each registered ' +
      'repo\'s live index state (indexed/stale/unindexed/missing). Index-of-indexes: no merged graph. Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        directory: { type: 'string', description: DIR_DESC },
      },
      required: ['directory'],
    },
  },
  {
    name: 'spec_store_status',
    description:
      'Report the health of a spec-store binding: an external spec repository (.openlore/config.json ' +
      '"specStore") whose declared target/reference repositories are resolved against the federation ' +
      'registry. Returns conclusion-shaped findings with stable codes (target-unresolved, index-stale, ' +
      'reference-missing, …) and pasteable remediations. Read-only; never blocks.',
    inputSchema: {
      type: 'object',
      properties: {
        directory: { type: 'string', description: DIR_DESC },
      },
      required: ['directory'],
    },
  },
  {
    name: 'working_set_context',
    description:
      'Assemble the working-set structural briefing for an active change in a spec-store binding: ' +
      'orient, generalized from one repo to the change\'s target repositories. Reads the change\'s ' +
      'proposal under the bound store, orients each resolved+indexed target on that intent, and returns ' +
      'ONE deterministic, token-budgeted briefing whose items are attributed per target (symbol, callers, ' +
      'spec domains, insertion points) plus fresh in-scope anchored intent. Conclusion-shaped, read-only, ' +
      'never blocks; orphaned intent is withheld and drifted intent is flagged. No LLM.',
    inputSchema: {
      type: 'object',
      properties: {
        directory: { type: 'string', description: DIR_DESC },
        change: { type: 'string', description: 'The active change id to brief (its proposal lives under the bound store).' },
        tokenBudget: { type: 'number', description: 'Cap the merged briefing to ~this many tokens (default 8000).' },
      },
      required: ['directory'],
    },
  },
  {
    name: 'change_impact_certificate',
    description:
      'Certify what the current diff touches before it lands. ONE conclusion-shaped certificate: blast ' +
      'radius, the paths the change NEWLY OPENS into each declared covering surface (reachable after but ' +
      'not before — computed differentially), drifted specs, and tests to run. Decays via the freshness ' +
      'lease; advisory, never blocks. Declare surfaces under "impactCertificate.surfaces". No LLM.',
    inputSchema: {
      type: 'object',
      properties: {
        directory: { type: 'string', description: DIR_DESC },
        baseRef: { type: 'string', description: 'Git ref to diff the working tree against (default HEAD).' },
        change: { type: 'string', description: 'Change id to record on the certificate (spec-store context; default "working-tree").' },
        persist: { type: 'boolean', description: 'Persist under .openlore/impact-certificates/ so the spec-store health check can re-fire it when it decays.' },
      },
      required: ['directory'],
    },
  },
  {
    name: 'plan_parallel_work',
    description:
      'USE THIS WHEN: before fanning N tasks out across agents/worktrees — "which of these tasks are ' +
      'safe to run concurrently, and in what order?". Given a caller-supplied task list (id + seed ' +
      'symbols/files each), returns the plan: a hazard-typed conflict graph (WAW/shared-append/RAW/WAR/' +
      'soft-coupling), a wave schedule (wave 1 = dispatch now), and the critical path (minimum rounds ' +
      'with unlimited agents). Stateless, advisory; re-invoke with remaining tasks to re-plan. Mark ' +
      'registration-site touches writeMode:"append" so they are not falsely serialized. Run ' +
      'analyze_codebase first.',
    inputSchema: {
      type: 'object',
      properties: {
        directory: { type: 'string', description: DIR_DESC },
        tasks: {
          type: 'array',
          description: 'Task descriptors; each needs an id and ≥1 seed (symbol or file). The list is never invented or decomposed.',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'Unique task id within this call.' },
              seedSymbols: { type: 'array', items: { type: 'string' }, description: 'Symbol names/ids the task will edit.' },
              seedFiles: { type: 'array', items: { type: 'string' }, description: 'File paths the task will edit (every symbol in the file enters the write-set).' },
              intent: { type: 'string', description: 'Optional intent text (widens sparse seeds only; never guesses edits).' },
              writeMode: { type: 'string', enum: ['append', 'modify'], description: '"append" for pure registration-site additions (default "modify").' },
            },
            required: ['id'],
          },
        },
      },
      required: ['directory', 'tasks'],
    },
  },
  {
    name: 'map_in_flight_conflicts',
    description:
      'USE THIS WHEN: many humans/agents edit one codebase (or federation) and you want — before merge — ' +
      'which in-flight changes collide. Builds ONE cross-actor conflict graph over every change in flight: ' +
      'local branches, open PRs (via gh), and supplied agent task descriptors, as nodes of the same kind. ' +
      'Each footprint is derived from the ACTUAL diff (per-symbol append vs modify read off the hunks, so ' +
      'two PRs appending disjoint registry entries do NOT falsely conflict); the hazard classifier ' +
      '(WAW/RAW/shared-append/WAR) then runs across all nodes. Returns per conflict: the two actors, ' +
      'hazard, shared symbols, suggested landing order. A change whose diff can\'t be fetched or whose ' +
      'symbols don\'t resolve is "not assessed", never "no conflict". Read-only, stateless, advisory; ' +
      'opt-in federation matches across repos by stable id. Run analyze_codebase first.',
    inputSchema: {
      type: 'object',
      properties: {
        directory: { type: 'string', description: DIR_DESC },
        baseRef: { type: 'string', description: 'Git ref every change is diffed against (default: resolved default branch).' },
        includeBranches: { type: 'boolean', description: 'Include local branches ahead of base (default true).' },
        branches: { type: 'array', items: { type: 'string' }, description: 'Restrict to these branch names (default: all ahead of base).' },
        includePullRequests: { type: 'boolean', description: 'Include open PRs via gh (default true; absent gh degrades).' },
        tasks: {
          type: 'array',
          description: 'Optional agent task descriptors that join as first-class nodes (plan_parallel_work shape: id + seedSymbols/seedFiles + optional writeMode).',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              seedSymbols: { type: 'array', items: { type: 'string' } },
              seedFiles: { type: 'array', items: { type: 'string' } },
              intent: { type: 'string' },
              writeMode: { type: 'string', enum: ['append', 'modify'] },
            },
            required: ['id'],
          },
        },
        maxChanges: { type: 'number', description: 'Cap on assessed changes (default 40).' },
        ...FEDERATION_PROPS,
      },
      required: ['directory'],
    },
  },
  {
    name: 'get_language_support',
    description:
      'USE THIS WHEN: a structural result for some file looks empty/weak and you need to know whether ' +
      'that means "nothing found" or "this language is only partly supported" — or when evaluating ' +
      'coverage for a polyglot repo. Returns the deterministic capability matrix (signatures, callGraph, ' +
      'imports, cfgOverlay, typeInference, styleFingerprint, iacProjection) for the repo\'s DETECTED ' +
      'languages, or — with a `language` name — that one language (a pure registry lookup; an unknown ' +
      'language returns an honest all-unsupported record, never an error). Fail-soft: an unsupported ' +
      'capability yields nothing, never a guess. Read-only, deterministic. Run analyze_codebase first ' +
      'for repo mode (named-language mode needs no analysis).',
    inputSchema: {
      type: 'object',
      properties: {
        directory: { type: 'string', description: DIR_DESC },
        language: { type: 'string', description: 'Optional: a specific language name (e.g. "Go", "Kotlin"). Omit to report the repo\'s detected languages.' },
      },
      required: ['directory'],
    },
  },
  {
    name: 'report_coverage_gaps',
    description:
      'USE THIS WHEN: you need to know which important code has NO test reaching it — a reviewer ' +
      'asking "is the risky part of this change tested?", an agent told to "improve coverage" and ' +
      'needing where to start, or an audit wanting the untested HUBS ranked, not a flat list. ' +
      'Computes the structural inverse of select_tests over the whole graph (functions in no test\'s ' +
      'reachable set), ranked by hub/chokepoint significance so load-bearing untested code floats to ' +
      'the top. SOUND DIRECTION ONLY: it reports "no reaching test" and NEVER claims a symbol is ' +
      '"tested" — reachable-from-a-test is not behavior-verified. Distinct from find_dead_code (a gap ' +
      'with no caller at all is labeled also-dead) and from get_test_coverage (spec-tag based). ' +
      'No runtime, no coverage tool, deterministic. Scope to a diff (changedSymbols/diffRef) or a ' +
      'region (filePattern). Run analyze_codebase first.',
    inputSchema: {
      type: 'object',
      properties: {
        directory: { type: 'string', description: DIR_DESC },
        maxResults: { type: 'number', description: 'Limit reported gaps (default 100, capped 500).' },
        filePattern: { type: 'string', description: 'Only report gaps whose file path contains this substring (region scope).' },
        changedSymbols: { type: 'array', items: { type: 'string' }, description: 'Restrict to gaps among these changed symbols (diff scope).' },
        diffRef: { type: 'string', description: 'Git ref to diff the working tree against for diff scope (e.g. "HEAD", "main").' },
        directResolvedOnly: { type: 'boolean', description: 'Count only directly-resolved edges as test-reach (ignore synthesized dynamic-dispatch); reports more gaps, more certainly. Default false.' },
      },
      required: ['directory'],
    },
  },
  {
    name: 'detect_changes',
    description:
      'Detect recently changed functions and rank them by blast radius. ' +
      'Runs git diff against a base ref (default HEAD), maps changed lines to function nodes, ' +
      'then scores each changed function by fan-in + transitive callers. ' +
      'Highest-scored functions are the riskiest to break. ' +
      'Also reports test coverage for each changed function via tested_by edges. ' +
      'Run analyze_codebase first.',
    inputSchema: {
      type: 'object',
      properties: {
        directory: { type: 'string', description: DIR_DESC },
        base: {
          type: 'string',
          description: 'Git ref to diff against (default: HEAD). Use "HEAD~1" for last commit, "main" for branch diff.',
        },
      },
      required: ['directory'],
    },
  },
  {
    name: 'get_health_map',
    description:
      'Return a structural health dashboard: hubs (high fan-in), god functions (high fan-out), ' +
      'layer violations, and volatile files — aggregated in one call and ranked by severity. ' +
      'Use this as a starting point before a refactor or code review to identify the riskiest areas. ' +
      'Drill in with get_critical_hubs, get_god_functions, get_change_coupling, or find_dead_code. ' +
      'Run analyze_codebase first.',
    inputSchema: {
      type: 'object',
      properties: {
        directory: { type: 'string', description: DIR_DESC },
        limit: {
          type: 'number',
          description: 'Max items per hotspot list and max topRisks (default: 10, max: 50)',
        },
      },
      required: ['directory'],
    },
  },
  {
    name: 'get_surprising_connections',
    description:
      'Find unexpected structural coupling via composite scoring: cross-community edges, ' +
      'peripheral-to-hub calls, and cross-test-boundary dependencies. ' +
      'Use before a refactor or code review to spot accidental dependencies. ' +
      'Run analyze_codebase first.',
    inputSchema: {
      type: 'object',
      properties: {
        directory: { type: 'string', description: DIR_DESC },
        limit: {
          type: 'number',
          description: 'Max results to return (default: 15, max: 50)',
        },
      },
      required: ['directory'],
    },
  },
  {
    name: 'record_decision',
    description:
      'Record an architectural decision made during the current development session. ' +
      'Call this whenever you make a significant design choice: choosing a data structure, ' +
      'picking a library, defining an API contract, selecting an auth strategy, etc. ' +
      'Decisions are stored as drafts and consolidated before the next commit. ' +
      'Use the supersedes field when a later decision replaces an earlier one.',
    inputSchema: {
      type: 'object',
      properties: {
        directory: { type: 'string', description: DIR_DESC },
        title: { type: 'string', description: 'Short imperative statement, e.g. "Use UUIDs for decision IDs"' },
        rationale: { type: 'string', description: 'Why this decision was made' },
        consequences: { type: 'string', description: 'What changes as a result (optional)' },
        affectedFiles: {
          type: 'array',
          items: { type: 'string' },
          description: 'Source files most relevant to this decision (optional)',
        },
        supersedes: {
          type: 'string',
          description: 'ID of a prior decision this one replaces (optional)',
        },
        scope: {
          type: 'string',
          enum: ['local', 'component', 'cross-domain', 'system'],
          description: 'Decision scope. local: single file; component: single module/service; cross-domain: multiple spec domains or service contracts; system: global constraint. Only cross-domain and system generate ADR files. Defaults to component; auto-promoted to cross-domain when multiple domains inferred.',
        },
      },
      required: ['directory', 'title', 'rationale'],
    },
  },
  {
    name: 'list_decisions',
    description:
      'List architectural decisions recorded during the current session. ' +
      'Shows draft, consolidated, verified, approved, rejected, and synced decisions. ' +
      'Use approve_decision or reject_decision to act on verified decisions, ' +
      'then sync_decisions to write them to spec.md files.',
    inputSchema: {
      type: 'object',
      properties: {
        directory: { type: 'string', description: DIR_DESC },
        status: {
          type: 'string',
          enum: ['draft', 'consolidated', 'verified', 'phantom', 'approved', 'rejected', 'synced'],
          description: 'Filter by status (default: returns all)',
        },
      },
      required: ['directory'],
    },
  },
  {
    name: 'approve_decision',
    description:
      '⚠ REQUIRES EXPLICIT HUMAN AUTHORIZATION — do NOT call this tool autonomously. ' +
      'Before calling, you MUST present the decision to the user and receive an explicit ' +
      '"yes" or "approve" response. Never approve on behalf of the user. ' +
      'Approves a verified architectural decision for syncing into spec.md files. ' +
      'After approving, call sync_decisions to write the decision to the relevant spec.',
    inputSchema: {
      type: 'object',
      properties: {
        directory: { type: 'string', description: DIR_DESC },
        id: { type: 'string', description: '8-character decision ID from list_decisions' },
        note: { type: 'string', description: 'Optional review note' },
      },
      required: ['directory', 'id'],
    },
  },
  {
    name: 'reject_decision',
    description:
      'Reject a pending decision. Rejected decisions are never synced to spec files.',
    inputSchema: {
      type: 'object',
      properties: {
        directory: { type: 'string', description: DIR_DESC },
        id: { type: 'string', description: '8-character decision ID from list_decisions' },
        note: { type: 'string', description: 'Optional reason for rejection' },
      },
      required: ['directory', 'id'],
    },
  },
  {
    name: 'sync_decisions',
    description:
      'Write all approved decisions into their target spec.md files. ' +
      'Appends new Requirement blocks and Decision sections (append-only, never overwrites). ' +
      'Creates ADR files in openspec/decisions/ for architectural decisions. ' +
      'Pass dryRun=true to preview without writing. ' +
      'Pass id to sync a single decision by ID.',
    inputSchema: {
      type: 'object',
      properties: {
        directory: { type: 'string', description: DIR_DESC },
        dryRun: { type: 'boolean', description: 'Preview without writing files (default: false)' },
        id: { type: 'string', description: 'Sync only this specific decision ID (default: all approved)' },
      },
      required: ['directory'],
    },
  },
  {
    name: 'remember',
    description:
      'Persist a durable, code-anchored memory to recall later (invariant/gotcha/rationale). Pass ' +
      'anchors (symbol and/or file) so it self-invalidates when that code changes. Optional: type ' +
      '(default note) and supersedes=<id> to retire a prior memory; re-recording the same ' +
      'content+anchor updates in place. For spec-synced decisions use record_decision.',
    inputSchema: {
      type: 'object',
      properties: {
        directory: { type: 'string', description: DIR_DESC },
        content: { type: 'string', description: 'The memory to persist (one self-contained fact).' },
        anchors: {
          type: 'array',
          description: 'Code this memory is about; each anchor names a symbol and/or file.',
          items: {
            type: 'object',
            properties: {
              symbol: { type: 'string', description: 'Function/method name (optional)' },
              file: { type: 'string', description: 'Repo-relative file path (optional)' },
            },
          },
        },
        tags: { type: 'array', items: { type: 'string' }, description: 'Optional retrieval tags.' },
        type: {
          type: 'string',
          enum: ['invariant', 'gotcha', 'rationale', 'convention', 'preference', 'todo', 'note'],
          description: 'Classification (default note); never inferred.',
        },
        supersedes: { type: 'string', description: 'Id of a prior memory to retire (kept queryable via asOf).' },
      },
      required: ['directory', 'content'],
    },
  },
  {
    name: 'recall',
    description:
      'Recall code-anchored memories (notes + decisions) for a task with a freshness verdict: fresh, ' +
      'drifted (verify), or orphaned (in needsReanchoring, never authoritative). Two authoritative ' +
      'memories on one symbol surface in unreconciled. Optional: asOf/changedSince (commit-ish) for ' +
      'history, type filter, federation (surface producer-repo memory on interfaces you call). Omit task to scan all.',
    inputSchema: {
      type: 'object',
      properties: {
        directory: { type: 'string', description: DIR_DESC },
        task: { type: 'string', description: 'What you are about to work on (optional).' },
        limit: { type: 'number', description: 'Max memories to return (default: 10).' },
        tokenBudget: { type: 'number', description: 'Optional token cap; reports withheld count.' },
        asOf: { type: 'string', description: 'Commit-ish: memory authoritative as of that commit.' },
        changedSince: { type: 'string', description: 'Commit-ish: memory recorded/invalidated after it.' },
        type: { type: 'string', description: 'Restrict notes to this type (decisions excluded when set).' },
        ...FEDERATION_PROPS,
      },
      required: ['directory'],
    },
  },
];

// ============================================================================
// MCP SERVER
// ============================================================================

// Annotations improve Tool Search relevance in Claude Code (BM25/regex ranking).
// RO = read-only queries, RW_I = writes but idempotent, RW = non-idempotent writes.
const _RO  = { readOnlyHint: true,  destructiveHint: false, idempotentHint: true  } as const;
const _RWI = { readOnlyHint: false, destructiveHint: false, idempotentHint: true  } as const;
const _RW  = { readOnlyHint: false, destructiveHint: false, idempotentHint: false } as const;

const TOOL_ANNOTATIONS: Record<string, typeof _RO | typeof _RWI | typeof _RW> = {
  orient: _RO, analyze_codebase: _RWI, get_architecture_overview: _RO,
  get_refactor_report: _RO, get_call_graph: _RO, get_duplicate_report: _RO,
  get_signatures: _RO, get_subgraph: _RO, trace_execution_path: _RO,
  get_mapping: _RO, check_spec_drift: _RO, analyze_impact: _RO, select_tests: _RO, blast_radius: _RO, find_dead_code: _RO, structural_diff: _RO, get_change_coupling: _RO, check_architecture: _RO,
  get_low_risk_refactor_candidates: _RO, get_leaf_functions: _RO,
  get_critical_hubs: _RO, get_function_skeleton: _RO, get_god_functions: _RO,
  suggest_insertion_points: _RO, search_code: _RO, list_spec_domains: _RO,
  search_specs: _RO, search_unified: _RO, get_spec: _RO, get_function_body: _RO,
  get_file_dependencies: _RO, generate_change_proposal: _RW, annotate_story: _RW,
  get_route_inventory: _RO, get_middleware_inventory: _RO,
  get_schema_inventory: _RO, get_ui_components: _RO, get_env_vars: _RO,
  get_external_packages: _RO, audit_spec_coverage: _RO, generate_tests: _RW,
  get_test_coverage: _RO, get_minimal_context: _RO, get_cluster: _RO,
  detect_changes: _RO, get_health_map: _RO, get_surprising_connections: _RO, record_decision: _RW, list_decisions: _RO,
  approve_decision: _RWI, reject_decision: _RWI, sync_decisions: _RWI,
  remember: _RW, recall: _RO, verify_claim: _RO,
  spec_store_status: _RO, working_set_context: _RO, change_impact_certificate: _RO,
  plan_parallel_work: _RO, map_in_flight_conflicts: _RO, get_language_support: _RO,
  report_coverage_gaps: _RO,
};

// Tools that touch external entities (LLM / network) → openWorldHint: true.
// Everything else is local, deterministic, closed-world analysis.
const OPEN_WORLD_TOOLS = new Set<string>(['generate_tests', 'generate_change_proposal', 'annotate_story']);

/** Human-readable title from a snake_case tool name (spec-11 annotations). */
function toolTitle(name: string): string {
  return name.split('_').map(w => (w ? w[0].toUpperCase() + w.slice(1) : w)).join(' ');
}

/** Full MCP `annotations` for a tool: read/write hints + title + openWorldHint (spec-11). */
export function toolAnnotations(name: string): Record<string, unknown> {
  return {
    title: toolTitle(name),
    ...(TOOL_ANNOTATIONS[name] ?? _RO),
    openWorldHint: OPEN_WORLD_TOOLS.has(name),
  };
}

const MINIMAL_TOOLS = new Set([
  'orient', 'search_code', 'record_decision', 'detect_changes', 'check_spec_drift', 'get_health_map',
]);

// Named tool presets (Spec 14). A small, navigation-focused surface keeps the
// per-request tool-schema overhead low (the MCP best-practice: schemas for tools
// the agent never calls are pure overhead) while still exposing the graph-
// traversal tools a "how does X reach Y" task actually needs — which `minimal`
// (orient + search + governance) omits. CodeGraph wins its benchmark with a
// surface like this; openlore's was either too lean (no traversal) or all ~60.
export const TOOL_PRESETS: Record<string, Set<string>> = {
  minimal: MINIMAL_TOOLS,
  // Graph-navigation core: orient to enter, then traverse/trace/impact + compact
  // symbol bodies — no governance tools, no inventories.
  navigation: new Set([
    'orient', 'search_code', 'get_subgraph', 'trace_execution_path',
    'analyze_impact', 'suggest_insertion_points', 'get_function_skeleton',
    'get_landmarks', 'get_map', 'find_path',
  ]),
  // Code-anchored persistent memory (opt-in): orient to ground, remember to
  // persist a code-anchored note, recall to retrieve with a freshness verdict.
  // Deliberately NOT in the default or `minimal` surface (mcp-quality: minimize
  // the tools an agent must consider).
  memory: new Set([
    'orient', 'remember', 'recall',
  ]),
  // Claim verification (opt-in): orient to ground, then verify a structural claim
  // (calls/reaches/dead/impacts/safe-to-change) or a decision-authority claim
  // (decision-current) and cite the receipt before asserting it to a human.
  // Deliberately NOT in the default or `minimal` surface (mcp-quality: minimize the
  // tools an agent must consider). search_code helps the agent name the subject precisely.
  verify: new Set([
    'orient', 'search_code', 'verify_claim',
  ]),
  // Multi-repo federation (opt-in): the cross-repo conclusion tools plus the
  // registry status tool. `federation_status` exists ONLY here — the default and
  // `minimal` surfaces register no federation capability (change:
  // add-multi-repo-federation; architecture: FederationScopedConclusions opt-in).
  federation: new Set([
    'orient', 'federation_status', 'spec_store_status', 'working_set_context', 'change_impact_certificate',
    'analyze_impact', 'find_dead_code', 'select_tests', 'find_path', 'map_in_flight_conflicts',
  ]),
  // Parallel-work coordination (opt-in): orient to ground, then plan_parallel_work to
  // schedule N proposed tasks into safe-to-dispatch waves + a critical path, or
  // map_in_flight_conflicts to find collisions across every change already in flight
  // (branches/PRs/tasks). analyze_impact and find_path help an agent name and scope the
  // seed symbols a task will touch. Deliberately NOT in the default or `minimal` surface
  // (mcp-quality: minimize the tools an agent must consider; changes: add-parallel-work-plan,
  // add-cross-actor-interference-map).
  coordination: new Set([
    'orient', 'plan_parallel_work', 'map_in_flight_conflicts', 'analyze_impact', 'find_path',
  ]),
};

/**
 * Resolve a tool-selector option set to its canonical preset name (change:
 * default-to-lean-tool-surface). Precedence: `--all-tools`/`--preset full`/`all`
 * → `full`; `--preset <name>` → that name; legacy `--minimal` → `minimal`; no
 * selector → the lean default (`navigation`). Pure; the single source of truth
 * both `selectActiveTools` and `leanDefaultActive` resolve through, so the active
 * surface and the breadth-pointer decision can never disagree.
 */
export function resolvePresetName(opts: { minimal?: boolean; preset?: string; allTools?: boolean }): string {
  if (opts.allTools) return FULL_PRESET;
  if (opts.preset) return opts.preset === FULL_PRESET_ALIAS ? FULL_PRESET : opts.preset;
  if (opts.minimal) return 'minimal';
  return LEAN_DEFAULT_PRESET;
}

/**
 * Resolve which tools an MCP session exposes (Spec 14; change:
 * default-to-lean-tool-surface). `--all-tools`/`--preset full` → the full
 * registry; `--preset <name>` → that preset; legacy `--minimal` → the 'minimal'
 * preset; **no selector → the lean default surface** (the benchmark-winning
 * `navigation` preset), NOT the full registry. Breadth is opt-in because schemas
 * for tools the agent never calls are pure per-request overhead (mcp-quality:
 * MinimizeToolSurface). An unknown preset throws so a typo fails loudly instead of
 * silently exposing all tools. Pure + exported for unit testing.
 */
export function selectActiveTools<T extends { name: string }>(
  allTools: T[],
  opts: { minimal?: boolean; preset?: string; allTools?: boolean },
): T[] {
  const presetName = resolvePresetName(opts);
  // The full surface is the registry itself — no Set to maintain, so adding a
  // tool never needs a `full` membership edit (and it can't drift out of sync).
  if (presetName === FULL_PRESET) return allTools;
  const preset = TOOL_PRESETS[presetName];
  if (!preset) {
    // Echo the raw user input (untrimmed/cased) so a near-miss like "Full" or
    // "full " is legible; the caller catches this and exits cleanly (no stack).
    throw new Error(`Unknown --preset "${opts.preset ?? presetName}". Known presets: ${[...Object.keys(TOOL_PRESETS), FULL_PRESET].join(', ')}.`);
  }
  return allTools.filter(t => preset.has(t.name));
}

interface McpServerOptions {
  watch?: string;
  watchAuto?: boolean;
  /** Spawn a shared `openlore serve` daemon when none is running and delegate to
   * it. Without this, MCP only reuses an already-running daemon. */
  daemon?: boolean;
  watchDebounce?: string;
  watchNoEmbed?: boolean;
  minimal?: boolean;
  preset?: string;
  allTools?: boolean;
}

/**
 * One-line breadth pointer emitted via the MCP `instructions` channel (server
 * info, NOT a tool schema) when the lean default surface is active, so an agent
 * that needs governance/memory/verify/federation tools learns the opt-in exists
 * rather than concluding the capability is absent. Every opt-in is named in the
 * `--preset <name>` form so it is copy-pasteable into both `openlore mcp` and
 * `openlore install`. Adds zero tool schemas (change: default-to-lean-tool-surface).
 */
export const BREADTH_POINTER =
  'OpenLore is running its lean default tool surface (the navigation core). ' +
  'More tools are available behind named presets — governance (`--preset minimal`), ' +
  'memory (`--preset memory`), claim verification (`--preset verify`), ' +
  'multi-repo federation (`--preset federation`), or the full surface ' +
  '(`--preset full`). Re-wire with `openlore install --preset <name>`.';

/**
 * True when the active surface IS the lean default (the `navigation` preset) —
 * whether reached by no selector at all OR by an explicit `--preset navigation`
 * (which is how `openlore install` wires the default). The server cannot tell the
 * two apart and shouldn't: an agent on the lean surface should learn breadth
 * exists regardless of how it got there. Any OTHER surface (`minimal`, `memory`,
 * `verify`, `federation`, or `full`) is a deliberate different choice, so the
 * pointer would be noise and is suppressed. Resolves through resolvePresetName so
 * it can never disagree with the active tool set. Exported + pure for unit testing.
 */
export function leanDefaultActive(opts: { minimal?: boolean; preset?: string; allTools?: boolean }): boolean {
  return resolvePresetName(opts) === LEAN_DEFAULT_PRESET;
}

async function startMcpServer(options: McpServerOptions = {}): Promise<void> {
  // The MCP stdio transport uses stdout EXCLUSIVELY for the JSON-RPC stream.
  // Any stray write to stdout — e.g. logger.success("Successfully validated
  // directory…") from validateDirectory(), which runs on nearly every tool
  // call — corrupts the protocol and can break strict clients. Route all
  // console diagnostics to stderr. The SDK transport writes protocol messages
  // via process.stdout.write directly, so it is unaffected, and logger.error
  // already uses console.error (stderr).
  const toStderr = (...args: unknown[]): void => {
    process.stderr.write(args.map(a => (typeof a === 'string' ? a : String(a))).join(' ') + '\n');
  };
  console.log = toStderr;
  console.info = toStderr;
  console.warn = toStderr;
  console.debug = toStderr;

  const selectorOpts = { minimal: options.minimal, preset: options.preset, allTools: options.allTools };
  // A bad `--preset` must fail like a CLI usage error (clean message, exit 2),
  // not an uncaught throw that dumps a Node stack trace — mirroring how
  // `openlore install` validates its preset (install/index.ts). stdout is the
  // JSON-RPC channel, so the message goes to stderr.
  let activeTools: typeof TOOL_DEFINITIONS;
  try {
    activeTools = selectActiveTools(TOOL_DEFINITIONS, selectorOpts);
  } catch (e) {
    process.stderr.write(`${(e as Error).message}\n`);
    process.exit(2);
  }
  // Advertise breadth once via server instructions only when the active surface
  // IS the lean default (navigation) — whether reached by no selector or an
  // explicit `--preset navigation` (how install wires it). This adds no tool schemas.
  const instructions = leanDefaultActive(selectorOpts) ? BREADTH_POINTER : undefined;

  // Report the real package version in the MCP initialize handshake rather
  // than a stale hardcoded string.
  const { version: pkgVersion } = _require('../../../package.json') as { version: string };
  const server = new Server(
    { name: 'openlore', version: pkgVersion },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: activeTools.map(t => ({ ...t, annotations: toolAnnotations(t.name) })),
  }));

  // Per-session epistemic lease tracker — re-initialized when directory changes.
  let tracker: EpistemicTracker | undefined;
  let trackerDir = '';
  let panicPolicy: PanicResponseMode = 'off';

  // --watch-auto: start the watcher on the first tool call that carries a directory
  let autoWatcher: import('../../core/services/mcp-watcher.js').McpWatcher | undefined;

  // Serve-daemon delegation: when a shared `openlore serve` daemon is available
  // for a directory, forward tool calls to it (one warm process + one watcher
  // for the repo, shared across agents) instead of dispatching in-process.
  // Resolved once per directory; null = no daemon, run locally. By default we
  // only DISCOVER and reuse an already-running daemon (started by pi, an explicit
  // `openlore serve`, or another `--daemon` MCP) — so a plain MCP session never
  // silently leaves a lingering background process. `--daemon` opts in to
  // SPAWNING a shared daemon when none is running.
  const daemonByDir = new Map<string, ServeEndpoint | null>();
  const daemonPending = new Map<string, Promise<ServeEndpoint | null>>();
  function resolveDaemon(dir: string): Promise<ServeEndpoint | null> {
    if (!dir) return Promise.resolve(null);
    if (daemonByDir.has(dir)) return Promise.resolve(daemonByDir.get(dir) ?? null);
    // Dedup concurrent calls for the same dir — without this, two parallel tool
    // calls both miss the cache and each call ensureServeDaemon, potentially
    // spawning two daemons (the dup-guard prevents double-start, but two
    // spawn-and-poll cycles waste time and connections).
    if (!daemonPending.has(dir)) {
      const p = ensureServeDaemon(dir, { spawn: options.daemon === true })
        .then(ep  => { daemonByDir.set(dir, ep);   daemonPending.delete(dir); return ep; })
        .catch(()  => { daemonByDir.set(dir, null); daemonPending.delete(dir); return null; });
      daemonPending.set(dir, p);
    }
    return daemonPending.get(dir)!;
  }

  // Agent identity captured from initialize handshake
  let agentName = 'unknown';
  let agentVersion = 'unknown';
  server.setRequestHandler(InitializeRequestSchema, async (request) => {
    agentName = request.params.clientInfo?.name ?? 'unknown';
    agentVersion = request.params.clientInfo?.version ?? 'unknown';
    // Protocol negotiation (spec-12): echo the client's requested version when we
    // support it (per the SDK's pinned set), else offer our latest supported one.
    const requested = request.params.protocolVersion;
    const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
      ? requested
      : LATEST_PROTOCOL_VERSION;
    return {
      protocolVersion,
      // Honest capabilities: only `tools`. No `listChanged` — the tool list is
      // static per session, so we don't advertise a capability we don't implement.
      capabilities: { tools: {} },
      serverInfo: { name: 'openlore', version: _pkgVersion },
      // Breadth pointer on the lean default surface only (change:
      // default-to-lean-tool-surface). This custom initialize handler overrides
      // the SDK default, so the pointer must be attached here, not via the Server
      // constructor's `instructions` option (which this handler shadows).
      ...(instructions ? { instructions } : {}),
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;

    if (options.watchAuto && !autoWatcher) {
      const dir = (args as Record<string, unknown>).directory;
      if (typeof dir === 'string') {
        // Prefer a shared serve daemon if one is reachable (reused by default,
        // or spawned with --daemon) — it runs the watcher (+ continuous
        // call-graph re-analyze) for the whole repo, so we don't start a second
        // watcher racing it. Fall back to an in-process watcher otherwise.
        const ep = await resolveDaemon(dir);
        if (!ep) {
          const { resolve } = await import('node:path');
          const { McpWatcher } = await import('../../core/services/mcp-watcher.js');
          const debounceMs = parseInt(options.watchDebounce ?? '400', 10);
          autoWatcher = new McpWatcher({
            rootPath: resolve(dir),
            debounceMs: isNaN(debounceMs) ? 400 : debounceMs,
            embed: !options.watchNoEmbed,
          });
          await autoWatcher.start();
          const cleanup = () => autoWatcher!.stop().then(() => process.exit(0));
          process.on('SIGINT',  cleanup);
          process.on('SIGTERM', cleanup);
        }
      }
    }

    const _dir = (args as Record<string, unknown>).directory;
    const directory = typeof _dir === 'string' ? _dir : '';
    const _t0 = Date.now();

    // Input validation (spec-10) against the tool's own declared inputSchema, before
    // dispatch. Invalid args become a JSON-RPC -32602 error (spec-12), not an
    // isError tool result — a malformed request is a protocol error, not a tool failure.
    {
      const toolDef = TOOL_DEFINITIONS.find(t => t.name === name);
      const argError = toolDef ? validateToolArgs(args, toolDef.inputSchema) : null;
      if (argError) {
        emit(directory, 'mcp', { event: 'tool_error', tool: name, ms: Date.now() - _t0, agent: agentName, code: 'INVALID_ARGS', error: argError });
        throw new McpError(ErrorCode.InvalidParams, `Invalid arguments for "${name}": ${argError}`);
      }
    }

    try {
      const filePath = (args as Record<string, unknown>).filePath;

      // Init (or re-init when project directory changes between calls)
      if (directory && (!tracker || directory !== trackerDir)) {
        tracker = createTracker(directory);
        trackerDir = directory;
        const cfg = await readOpenLoreConfig(directory);
        panicPolicy = cfg?.panicResponse?.mode ?? 'off';
      }
      // Update epistemic state before dispatch (orient resets tracker internally).
      // Invariant: only MCP tool calls (this path) feed panic. CLI commands (panic-check,
      // telemetry) are separate processes that read state but never call updateTracker —
      // no recursive panic feedback loop from openlore internal commands.
      if (tracker && directory) {
        const isOrient = name === 'orient';
        updateTracker(tracker, name, directory, typeof filePath === 'string' ? filePath : undefined);

        if (panicPolicy !== 'off') {
          // Read disk state to preserve hook-written fields (lastHookInterventionAt, gryphWindowStart)
          // that panic-check (separate process) may have set since the last MCP write.
          const diskState = readPanicState(directory);
          // orient() runs panic recovery (separate from updateTracker's freshness reset);
          // every other tool call runs the per-call panic signal update.
          if (isOrient) {
            resetPanicOnOrient(tracker, directory);
          } else {
            updatePanic(tracker, {
              density: tracker.density,
              oscillation: tracker.oscillation,
              weight: 1,
              staleDepth: tracker.staleDepth,
              directory,
              tool: name,
            });
          }
          // Locked read-modify-write so this per-call score/level update cannot clobber a
          // concurrent panic-check hook or gryph daemon write. The hook/daemon own the
          // cross-process fields (interventionCountSinceStable, lastHookInterventionAt,
          // gryphWindowStart), so they are carried over from the FRESHEST on-disk read, not
          // from the in-memory tracker. The counter is preserved while panicLevel > 0 (so a
          // concurrent hook increment survives) and reset to 0 at level 0 — matching the
          // tracker's own invariant (level 0 ⟺ count 0; see updatePanic/resetPanicOnOrient).
          const t = tracker; // capture non-null binding for the deferred closure
          const written = mutatePanicStateLocked(directory, (fresh) => ({
            ...trackerToPanicState(t, agentName),
            lastHookInterventionAt: fresh.lastHookInterventionAt,
            gryphWindowStart: fresh.gryphWindowStart,
            interventionCountSinceStable: t.panicLevel === 0 ? 0 : fresh.interventionCountSinceStable,
          }));
          t.panicRevision = written.revision;
          t.interventionCountSinceStable = written.interventionCountSinceStable;

          // Feedback loop: did orient() respond to a prior hook intervention?
          if (isOrient && diskState.lastHookInterventionAt) {
            const lagMs = Date.now() - new Date(diskState.lastHookInterventionAt).getTime();
            if (lagMs < 5 * 60 * 1000) {
              emit(directory, 'panic', {
                event: 'panic_intervention_outcome',
                outcome: 'responded',
                intervention_lag_ms: lagMs,
                orient_kind: tracker.recentOrientCount >= 3 ? 'spam' : tracker.recentOrientCount >= 2 ? 'rapid' : 'normal',
              });
            }
          }
        }
      }

      let result: unknown;
      let _unknownTool = false;

      // Per-tool timeout (spec-10): race the dispatch against the tool's budget so a
      // pathological hang can never wedge the server. Slow tools (analysis, LLM) have
      // generous overrides in MCP_TOOL_TIMEOUT_OVERRIDES.
      await withToolTimeout((async () => {
        // Delegate to a shared serve daemon when one is available (warm caches,
        // single watcher), else dispatch in-process. A daemon transport failure
        // falls back to in-process so a flaky daemon never breaks a tool call.
        const ep = await resolveDaemon(directory);
        try {
          if (ep) {
            try {
              result = await callServeTool(ep, name, args as Record<string, unknown>, directory);
            } catch {
              // Daemon unreachable/unknown-tool/transport error → drop it for this
              // session and run locally (also catches a daemon that died mid-session).
              daemonByDir.set(directory, null);
              result = await dispatchTool(name, args as Record<string, unknown>, directory);
            }
          } else {
            result = await dispatchTool(name, args as Record<string, unknown>, directory);
          }
        } catch (err) {
          if (err instanceof UnknownToolError) {
            _unknownTool = true;
            return;
          }
          throw err;
        }
        // orient emits navigation telemetry tied to the MCP session's agent.
        if (name === 'orient' && result && typeof result === 'object') {
          const r = result as Record<string, unknown>;
          emit(directory, 'orient', {
            event: 'orient_call',
            agent: agentName,
            functions: Array.isArray(r['relevantFunctions']) ? r['relevantFunctions'].length : 0,
            files: Array.isArray(r['relevantFiles']) ? r['relevantFiles'].length : 0,
            spec_domains: Array.isArray(r['specDomains']) ? r['specDomains'].length : 0,
            insertion_points: Array.isArray(r['insertionPoints']) ? r['insertionPoints'].length : 0,
          });
        }
      })(), name);

      if (_unknownTool) {
        return {
          content: [{ type: 'text', text: `Unknown tool: ${name}` }],
          isError: true,
        };
      }

      // Output cap (spec-10): bound the response to a byte budget rather than blowing
      // the agent's context. capStructuredResult truncates at the STRUCTURED level so a
      // JSON result stays valid+parseable (naive byte-truncation of serialized JSON cuts
      // mid-string-literal — e.g. get_spec on a >256 KB spec — and is unusable).
      const { text, truncated } = capStructuredResult(result, MCP_TOOL_MAX_BYTES);

      emit(directory, 'mcp', {
        event: 'tool_call', tool: name, ms: Date.now() - _t0, agent: agentName, agent_version: agentVersion,
        bytes: Buffer.byteLength(text, 'utf8'), outcome: truncated ? 'truncated' : 'ok',
        panic_level: tracker?.panicLevel ?? 0,
        panic_score: tracker?.panicScore ?? 0,
      });

      const signal = tracker ? getFreshnessSignal(tracker) : null;

      // Both freshness and panic signals are separate content items — never
      // concatenated into the result body — so structured outputs (JSON, patches)
      // are not corrupted. Panic signal always appended (after result).
      const content: Array<{ type: 'text'; text: string }> = [];
      if (signal?.prepend) content.push({ type: 'text', text: signal.text });
      content.push({ type: 'text', text });
      if (signal && !signal.prepend) content.push({ type: 'text', text: signal.text });

      if (tracker && (panicPolicy === 'advisory' || panicPolicy === 'experimental_blocking')) {
        const panicState = trackerToPanicState(tracker, agentName);
        const panicText = getPanicSignalText(panicState);
        if (panicText) {
          content.push({ type: 'text', text: panicText });
          // An injected signal is itself an intervention. Increment the SHARED on-disk
          // counter under the lock so it composes with concurrent panic-check hook
          // increments rather than clobbering them (the advisory→directive escalation
          // gate reads this unified count). Carry hook/daemon-owned fields from disk.
          const t = tracker; // capture non-null binding for the deferred closure
          const written = mutatePanicStateLocked(directory, (fresh) => ({
            ...trackerToPanicState(t, agentName),
            lastHookInterventionAt: fresh.lastHookInterventionAt,
            gryphWindowStart: fresh.gryphWindowStart,
            interventionCountSinceStable: fresh.interventionCountSinceStable + 1,
          }));
          t.panicRevision = written.revision;
          t.interventionCountSinceStable = written.interventionCountSinceStable;
          emit(directory, 'panic', {
            event: 'panic_signal_injected',
            panic_level: tracker.panicLevel,
            panic_score: tracker.panicScore,
            intervention_count: tracker.interventionCountSinceStable,
            directive_mode: tracker.interventionCountSinceStable >= 3,
            tool: name,
            agent: agentName,
          });
        }
      }

      return { content };
    } catch (err) {
      // A thrown McpError is a protocol-level error (e.g. -32602) — let the SDK
      // serialize it as a JSON-RPC error response, not a tool isError result.
      if (err instanceof McpError) throw err;
      // Error normalization (spec-10): a stable code taxonomy, distinguishing
      // "repo not analyzed yet" (actionable) from real failures and timeouts.
      const code = classifyToolError(err);
      const message = sanitizeMcpError(err);
      emit(directory, 'mcp', { event: 'tool_error', tool: name, ms: Date.now() - _t0, agent: agentName, code, outcome: 'error', error: message });
      return {
        content: [{ type: 'text', text: `Tool error [${code}]: ${message}` }],
        isError: true,
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  if (options.watch) {
    const { resolve } = await import('node:path');
    const watchDir = resolve(options.watch);
    // Don't start a second watcher when a daemon is already watching this
    // directory — that's exactly the invariant this PR establishes.
    // Check discover-only (spawn:false): --watch is an explicit opt-in; if the
    // user also started a daemon, they want delegation, not two watchers racing.
    const existingDaemon = await ensureServeDaemon(watchDir, { spawn: false });
    if (!existingDaemon) {
      const { McpWatcher } = await import('../../core/services/mcp-watcher.js');
      const debounceMs = parseInt(options.watchDebounce ?? '400', 10);
      const watcher = new McpWatcher({
        rootPath: watchDir,
        debounceMs: isNaN(debounceMs) ? 400 : debounceMs,
        embed: !options.watchNoEmbed,
      });
      await watcher.start();
      const cleanup = () => watcher.stop().then(() => process.exit(0));
      process.on('SIGINT',  cleanup);
      process.on('SIGTERM', cleanup);
    }
  }
}

// ============================================================================
// COMMAND EXPORT
// ============================================================================

export const mcpCommand = new Command('mcp')
  .description('Start openlore as an MCP server (stdio transport, for Cline/Claude Code)')
  .option('--watch <directory>', 'Watch a project directory and incrementally re-index signatures on file changes')
  .option('--watch-auto', 'Auto-detect the project directory from the first tool call and start watching', true)
  .option('--no-watch-auto', 'Disable auto-watch (use for one-shot tool calls, e.g. the orient skill wrapper)')
  .option('--daemon', 'Delegate tool calls to a shared `openlore serve` daemon, spawning one if needed (coherent state across agents — one warm process + one watcher per repo). Without it, MCP reuses a daemon only if one is already running, else runs in-process.')
  .option('--watch-debounce <ms>', 'Debounce delay in ms before re-indexing after a file change (default: 400)', '400')
  .option('--watch-no-embed', 'Watch signatures only — skip live vector re-embedding (embeddings refresh at commit). Large repos auto-degrade to this.')
  .option('--minimal', 'Expose only core 6 tools (orient, search_code, record_decision, detect_changes, check_spec_drift, get_health_map). Pair with alwaysLoad: true in Claude Code for always-visible core tools.')
  .option('--preset <name>', `Expose a named tool preset. Default (no preset) is the lean "navigation" surface — the benchmark-winning graph-traversal core (orient, search_code, get_subgraph, trace_execution_path, analyze_impact, suggest_insertion_points, get_function_skeleton, get_landmarks, get_map, find_path) — NOT the full registry. "minimal" = orient+search+governance; "memory" = orient+remember+recall; "verify" = orient+search+verify_claim; "federation" = orient + federation_status + spec_store_status + working_set_context + change_impact_certificate + map_in_flight_conflicts + the four cross-repo conclusion tools; "coordination" = orient + plan_parallel_work + map_in_flight_conflicts + analyze_impact + find_path; "full" = all ${TOOL_DEFINITIONS.length} tools (the prior default). Takes precedence over --minimal.`)
  .option('--all-tools', `Expose the full surface — all ${TOOL_DEFINITIONS.length} tools (alias for --preset full). Opt-in breadth; the lean navigation default is recommended.`)
  .action((options: McpServerOptions) => startMcpServer(options));
