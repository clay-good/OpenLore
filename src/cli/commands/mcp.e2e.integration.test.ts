/**
 * RIG-19 — End-to-end MCP server integration test
 *
 * Spawns the MCP server as a real subprocess over stdio and drives it with
 * raw JSON-RPC 2.0 messages.  Exercises the full stack:
 *
 *   test process → stdin/stdout → StdioServerTransport → handler → cached
 *   analysis artifacts → JSON-RPC response → assertions
 *
 * What unit tests cannot catch but this does:
 *   - JSON serialization / deserialization round-trips
 *   - Undefined / NaN fields that survive JSON.stringify (become null / drop)
 *   - Response size blowups (deeply nested objects, huge arrays)
 *   - Server lifecycle (startup latency, process exit on kill)
 *   - Request-id correlation across concurrent calls
 *
 * Prerequisites (same as RIG-17):
 *   openlore analyze          # build analysis artifacts (no --embed needed)
 *   npm run test:integration  # run this file
 *
 * The suite auto-skips when the analysis cache is missing.
 *
 * Note: this suite is excluded from the CI Unit Tests job, which is how the
 * "embeddings required" regression (spec-06) originally shipped. The BM25
 * search path is now also guarded by a plain unit test that DOES run in CI —
 * see mcp-handlers/bm25-no-embeddings.test.ts.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { StringDecoder } from 'node:string_decoder';

interface RpcMessage { id?: number; method?: string; result?: { content: Array<{ type: string; text: string }>; isError?: boolean }; error?: unknown }

// ============================================================================
// CONFIG
// ============================================================================

/** Root of the openlore repo — used as the test project directory */
const REPO_ROOT  = resolve(import.meta.dirname, '../../../');
const MCP_BIN    = join(REPO_ROOT, 'dist/cli/index.js');
const CACHE_FILE = join(REPO_ROOT, '.openlore/analysis/llm-context.json');

// ============================================================================
// MCP STDIO CLIENT
// ============================================================================

/**
 * Minimal MCP stdio client.
 *
 * The SDK's StdioServerTransport exchanges newline-delimited JSON — one
 * complete JSON object per line.  We buffer stdout and resolve pending reads
 * as lines arrive.
 */
class McpClient {
  private buf = '';
  // StringDecoder buffers incomplete multibyte UTF-8 sequences across stdout chunks —
  // a per-chunk `chunk.toString()` would corrupt a multibyte char split at a chunk boundary.
  private decoder = new StringDecoder('utf8');
  private nextId = 1;
  // Responses are correlated BY ID, not by arrival order: the server may complete
  // concurrent tool calls in any order, so a FIFO waiter queue would mis-route
  // out-of-order responses and deadlock. Each pending request owns a resolver keyed by id.
  private pending = new Map<number, (msg: RpcMessage) => void>();

  constructor(private proc: ChildProcess) {
    proc.stdout!.on('data', (chunk: Buffer) => {
      this.buf += this.decoder.write(chunk);
      let nl: number;
      while ((nl = this.buf.indexOf('\n')) !== -1) {
        const line = this.buf.slice(0, nl).trim();
        this.buf   = this.buf.slice(nl + 1);
        if (!line) continue;
        let msg: RpcMessage;
        try { msg = JSON.parse(line) as RpcMessage; } catch { continue; } // skip non-JSON log noise
        if (typeof msg.id === 'number') {
          const resolve = this.pending.get(msg.id);
          if (resolve) { this.pending.delete(msg.id); resolve(msg); }
        }
        // notifications (no id) and unmatched ids are ignored
      }
    });
  }

  /** Send a raw JSON-RPC object to stdin. */
  async send(msg: object): Promise<void> {
    return new Promise((resolve, reject) => {
      this.proc.stdin!.write(JSON.stringify(msg) + '\n', err =>
        err ? reject(err) : resolve(),
      );
    });
  }

  /** Send a request and await its response, correlated by id (robust to out-of-order
   *  concurrent responses). A cold MCP server spawn loads tree-sitter grammars and reads
   *  the multi-MB analysis context, which can exceed a few seconds on a busy machine; 30s
   *  avoids spurious timeouts while still failing a genuine hang. */
  async request(method: string, params: object = {}, timeoutMs = 30_000): Promise<RpcMessage> {
    const id = this.nextId++;
    const response = new Promise<RpcMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP response timeout after ${timeoutMs}ms (id ${id}, ${method})`));
      }, timeoutMs);
      this.pending.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
    });
    await this.send({ jsonrpc: '2.0', id, method, params });
    return response;
  }

  /** Convenience wrapper: call a tool and return the full response object. */
  async callTool(name: string, args: object = {}): Promise<{
    result?: { content: Array<{ type: string; text: string }>; isError?: boolean };
    error?: unknown;
    id: number;
  }> {
    return this.request('tools/call', { name, arguments: args }) as Promise<{
      result?: { content: Array<{ type: string; text: string }>; isError?: boolean };
      error?: unknown;
      id: number;
    }>;
  }

  /**
   * Parse the text content from a tool response.
   * MCP tool results always arrive as `{ content: [{ type:'text', text:'...' }] }`.
   */
  parseToolResult(resp: Awaited<ReturnType<McpClient['callTool']>>): unknown {
    expect(resp.result, 'Response has no result field').toBeDefined();
    expect(resp.result!.isError, 'Tool returned an error').toBeFalsy();
    const text = resp.result!.content?.[0]?.text;
    expect(text, 'Result content text is missing').toBeTruthy();
    return JSON.parse(text!);
  }

  /** Perform the MCP initialize + initialized handshake. */
  async initialize(): Promise<void> {
    const resp = await this.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities:    {},
      clientInfo:      { name: 'mcp-e2e-test', version: '1.0.0' },
    }) as { result?: { serverInfo?: { name: string } } };

    expect(resp.result?.serverInfo?.name).toBe('openlore');

    // Send the required `initialized` notification (no response expected)
    await this.send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
  }

  kill(): void { this.proc.kill('SIGTERM'); }
}

// ============================================================================
// HELPERS
// ============================================================================

function spawnServer(): McpClient {
  // change: default-to-lean-tool-surface — no-preset is now the lean navigation
  // surface (10 tools). This e2e exercises the full surface (asserts tools like
  // get_critical_hubs/get_spec and a ≥20 count), so it opts into `--preset full`.
  const proc = spawn('node', [MCP_BIN, 'mcp', '--preset', 'full'], {
    cwd:   REPO_ROOT,
    stdio: ['pipe', 'pipe', 'inherit'],   // inherit stderr so test logs show server errors
    env:   { ...process.env },
  });
  proc.on('error', err => { throw err; });
  return new McpClient(proc);
}

// ============================================================================
// SUITE
// ============================================================================

describe('RIG-19 — MCP e2e integration on real openlore codebase', () => {
  let client: McpClient;
  let cacheReady = false;

  beforeAll(async () => {
    cacheReady = existsSync(CACHE_FILE);
    if (!cacheReady) {
      console.warn(`  ⚠ No analysis cache at ${CACHE_FILE} — run "openlore analyze" first`);
      return;
    }
    client = spawnServer();
    await client.initialize();
  }, 20_000);

  afterAll(() => { client?.kill(); });

  function skip(label: string): boolean {
    if (!cacheReady) {
      console.warn(`  ⚠ [${label}] Skipping — analysis cache missing`);
      return true;
    }
    return false;
  }

  // --------------------------------------------------------------------------
  // Lifecycle
  // --------------------------------------------------------------------------

  it('server starts and responds to initialize', () => {
    if (!cacheReady) { console.warn('  ⚠ [lifecycle] cache missing'); return; }
    // Passing beforeAll without throwing is sufficient
    expect(cacheReady).toBe(true);
  });

  it('tools/list returns all expected tool names', async () => {
    if (skip('tools/list')) return;

    const resp = await client.request('tools/list') as { result?: { tools: Array<{ name: string }> } };
    const names = new Set(resp.result!.tools.map(t => t.name));

    const required = [
      'get_call_graph', 'get_signatures', 'get_architecture_overview',
      'get_subgraph', 'get_critical_hubs', 'get_file_dependencies',
      'search_code', 'orient', 'get_function_skeleton', 'get_spec',
      'trace_execution_path',
    ];
    for (const name of required) {
      expect(names.has(name), `Missing tool: ${name}`).toBe(true);
    }
    // Sanity: total count ≥ 20
    expect(resp.result!.tools.length).toBeGreaterThanOrEqual(20);
  });

  // --------------------------------------------------------------------------
  // get_call_graph — verifies JSON-RPC round-trip for a response with
  // nested objects and arrays (stats, hubFunctions, entryPoints)
  // --------------------------------------------------------------------------

  it('get_call_graph returns valid stats and hub functions', async () => {
    if (skip('get_call_graph')) return;

    const resp = await client.callTool('get_call_graph', { directory: REPO_ROOT });
    const data = client.parseToolResult(resp) as {
      stats: { totalNodes: number; totalEdges: number; avgFanIn: number; avgFanOut: number };
      hubFunctions: Array<{ name: string; file: string; fanIn: number; fanOut: number; language: string }>;
      entryPoints:  Array<{ name: string; file: string; language: string }>;
    };

    // Stats are present and coherent
    expect(typeof data.stats.totalNodes).toBe('number');
    expect(data.stats.totalNodes).toBeGreaterThan(100);
    expect(typeof data.stats.totalEdges).toBe('number');
    expect(data.stats.avgFanIn).toBeGreaterThanOrEqual(0);
    expect(data.stats.avgFanOut).toBeGreaterThanOrEqual(0);

    // Hub functions have all required fields (no undefined surviving serialization)
    expect(data.hubFunctions.length).toBeGreaterThan(0);
    for (const hub of data.hubFunctions) {
      expect(typeof hub.name).toBe('string');
      expect(hub.name.length).toBeGreaterThan(0);
      expect(typeof hub.file).toBe('string');
      expect(typeof hub.fanIn).toBe('number');
      expect(hub.fanIn).toBeGreaterThan(0);
      // null survives JSON — className may be null for top-level functions
      expect(hub.language).toBeTruthy();
    }

    // Entry points present
    expect(data.entryPoints.length).toBeGreaterThan(0);

    // Known hub: 'validateDirectory' is the highest fan-in function in openlore (called by all MCP handlers)
    const validateDir = data.hubFunctions.find(h => h.name === 'validateDirectory');
    expect(validateDir, '"validateDirectory" (highest fan-in hub) not found in hub list').toBeDefined();
  });

  // --------------------------------------------------------------------------
  // get_critical_hubs — verifies minFanIn filtering and response bounds
  // --------------------------------------------------------------------------

  it('get_critical_hubs respects minFanIn threshold', async () => {
    if (skip('get_critical_hubs')) return;

    const resp = await client.callTool('get_critical_hubs', {
      directory: REPO_ROOT,
      minFanIn:  5,
    });
    const data = client.parseToolResult(resp) as {
      totalHubs: number;
      returned:  number;
      minFanIn:  number;
      hubs: Array<{ name: string; file: string; fanIn: number; fanOut: number; language: string }>;
    };

    expect(data.totalHubs).toBeGreaterThan(0);
    expect(data.returned).toBe(data.hubs.length);
    expect(data.minFanIn).toBe(5);

    for (const hub of data.hubs) {
      expect(hub.fanIn, `Hub ${hub.name} fanIn ${hub.fanIn} < minFanIn 5`).toBeGreaterThanOrEqual(5);
      expect(typeof hub.fanOut).toBe('number');
      expect(hub.language).toBeTruthy();
    }
    // Hubs ordered by criticality descending (composite score, not raw fanIn)
    const withCriticality = data.hubs as unknown as Array<{ criticality: number }>;
    for (let i = 1; i < withCriticality.length; i++) {
      expect(withCriticality[i].criticality).toBeLessThanOrEqual(withCriticality[i - 1].criticality);
    }
  });

  // --------------------------------------------------------------------------
  // get_subgraph — verifies graph traversal produces a coherent subgraph
  // --------------------------------------------------------------------------

  it('get_subgraph returns connected subgraph for a known entry point', async () => {
    if (skip('get_subgraph')) return;

    // openloreRun has fanOut=22 — downstream subgraph must be large
    const resp = await client.callTool('get_subgraph', {
      directory:    REPO_ROOT,
      functionName: 'openloreRun',
      depth:        1,
      direction:    'downstream',
      format:       'json',
    });
    const data = client.parseToolResult(resp) as {
      query: { functionName: string; direction: number };
      seeds: Array<{ name: string; file: string; fanIn: number; fanOut: number }>;
      stats: { nodes: number; edges: number };
      nodes: Array<{ name: string; file: string; language: string; fanIn: number; fanOut: number }>;
      edges: Array<{ from: string; to: string }>;
    };

    expect(data.seeds.length).toBeGreaterThan(0);
    expect(data.seeds[0].name).toBe('openloreRun');
    // downstream depth-1 from openloreRun must contain many nodes
    expect(data.stats.nodes).toBeGreaterThan(5);
    expect(data.stats.edges).toBeGreaterThan(5);
    expect(data.nodes.length).toBe(data.stats.nodes);

    for (const node of data.nodes) {
      expect(node.name).toBeTruthy();
      expect(node.file).toBeTruthy();
      expect(node.language).toBeTruthy();
    }
  });

  // --------------------------------------------------------------------------
  // get_file_dependencies — verifies import graph response shape
  // --------------------------------------------------------------------------

  it('get_file_dependencies returns import graph with expected fields', async () => {
    if (skip('get_file_dependencies')) return;

    const resp = await client.callTool('get_file_dependencies', {
      directory: REPO_ROOT,
      filePath:  'src/core/analyzer/vector-index.ts',
      direction: 'both',
    });
    const data = client.parseToolResult(resp) as {
      filePath:      string;
      importsCount:  number;
      importedByCount: number;
      imports:       Array<{ filePath: string; importedNames: string[] }>;
      importedBy:    Array<{ filePath: string }>;
    };

    expect(data.filePath).toContain('vector-index');
    // vector-index.ts imports code-shaper, embedding-service, call-graph…
    expect(data.importsCount).toBeGreaterThan(0);
    expect(data.imports.length).toBe(data.importsCount);
    // vector-index.ts is imported by mcp-handlers, analyze, spec-pipeline…
    expect(data.importedByCount).toBeGreaterThan(0);
    expect(data.importedBy.length).toBe(data.importedByCount);

    for (const imp of data.imports) {
      expect(typeof imp.filePath).toBe('string');
      expect(imp.filePath.length).toBeGreaterThan(0);
      expect(Array.isArray(imp.importedNames)).toBe(true);
    }
  });

  // --------------------------------------------------------------------------
  // get_signatures — verifies signature extraction over the JSON-RPC wire
  // --------------------------------------------------------------------------

  it('get_signatures returns formatted text with expected content', async () => {
    if (skip('get_signatures')) return;

    // get_signatures returns a human-readable formatted text block, not JSON.
    const resp = await client.callTool('get_signatures', {
      directory:   REPO_ROOT,
      filePattern: 'vector-index',
    });
    expect(resp.result?.isError).toBeFalsy();
    const text = resp.result!.content[0]?.text ?? '';
    expect(text.length).toBeGreaterThan(0);

    // The output must reference the queried file
    expect(text).toContain('vector-index');
    // VectorIndex class and key methods must appear
    expect(text).toContain('VectorIndex');
    expect(text).toContain('build');
    expect(text).toContain('search');
    // Must be multi-line (not a single-line JSON dump)
    expect(text.split('\n').length).toBeGreaterThan(5);
  });

  // --------------------------------------------------------------------------
  // get_architecture_overview — large nested response, tests size & shape
  // --------------------------------------------------------------------------

  it('get_architecture_overview returns valid cluster structure', async () => {
    if (skip('get_architecture_overview')) return;

    const resp = await client.callTool('get_architecture_overview', { directory: REPO_ROOT });
    const data = client.parseToolResult(resp) as {
      summary: { totalFiles: number; totalClusters: number; totalEdges: number };
      clusters: Array<{ id: string; name: string; fileCount: number; role: string; keyFiles: string[] }>;
      globalEntryPoints: unknown[];
      criticalHubs:      unknown[];
    };

    expect(data.summary.totalFiles).toBeGreaterThan(0);
    expect(data.summary.totalClusters).toBe(data.clusters.length);
    expect(data.summary.totalEdges).toBeGreaterThanOrEqual(0);

    expect(data.clusters.length).toBeGreaterThan(0);
    for (const cluster of data.clusters) {
      expect(cluster.id).toBeTruthy();
      expect(cluster.name).toBeTruthy();
      expect(typeof cluster.fileCount).toBe('number');
      expect(cluster.fileCount).toBeGreaterThan(0);
      // role is a non-empty string (e.g. 'entry_layer', 'core', 'utility')
      expect(cluster.role).toBeTruthy();
      expect(Array.isArray(cluster.keyFiles)).toBe(true);
    }
    expect(Array.isArray(data.globalEntryPoints)).toBe(true);
    expect(Array.isArray(data.criticalHubs)).toBe(true);
  });

  // --------------------------------------------------------------------------
  // orient — composite entry-point for new tasks: semantic search + call graph
  // expansion + insertion points + spec domain recommendations
  // --------------------------------------------------------------------------

  it('orient returns structured task-orientation for a real query', async () => {
    if (skip('orient')) return;

    const resp = await client.callTool('orient', {
      directory: REPO_ROOT,
      task:      'add a new MCP tool that returns function docstrings',
      limit:     5,
    });
    const data = client.parseToolResult(resp) as {
      task:              string;
      searchMode:        string;
      relevantFiles:     string[];
      relevantFunctions: Array<{ name: string; filePath: string; score: number; language: string }>;
      specDomains:       Array<{ domain: string; specFile: string; matchCount: number }>;
      callPaths:         Array<{ function: string; filePath: string; callers: unknown[]; callees: unknown[] }>;
      insertionPoints:   Array<{ rank: number; name: string; filePath: string; role: string; strategy: string }>;
      nextSteps:         string[];
    };

    // Core fields always present
    expect(data.task).toBe('add a new MCP tool that returns function docstrings');
    expect(['hybrid', 'bm25_fallback']).toContain(data.searchMode);

    // Relevant functions with all required fields
    expect(Array.isArray(data.relevantFunctions)).toBe(true);
    expect(data.relevantFunctions.length).toBeGreaterThan(0);
    for (const fn of data.relevantFunctions) {
      expect(typeof fn.name).toBe('string');
      expect(fn.name.length).toBeGreaterThan(0);
      expect(typeof fn.filePath).toBe('string');
      expect(typeof fn.score).toBe('number');
      expect(typeof fn.language).toBe('string');
    }

    // Relevant files (deduplicated from function list)
    expect(Array.isArray(data.relevantFiles)).toBe(true);
    expect(data.relevantFiles.length).toBeGreaterThan(0);
    // All files are strings and actually appear in relevantFunctions
    const fnPaths = new Set(data.relevantFunctions.map(f => f.filePath));
    for (const file of data.relevantFiles) {
      expect(typeof file).toBe('string');
      expect(fnPaths.has(file)).toBe(true);
    }

    // Insertion points (up to 3, each with rank/role/strategy)
    expect(Array.isArray(data.insertionPoints)).toBe(true);
    for (const ip of data.insertionPoints) {
      expect(typeof ip.rank).toBe('number');
      expect(typeof ip.name).toBe('string');
      expect(typeof ip.filePath).toBe('string');
      expect(typeof ip.role).toBe('string');
      expect(typeof ip.strategy).toBe('string');
    }

    // Call paths (one per top function)
    expect(Array.isArray(data.callPaths)).toBe(true);
    for (const cp of data.callPaths) {
      expect(typeof cp.function).toBe('string');
      expect(Array.isArray(cp.callers)).toBe(true);
      expect(Array.isArray(cp.callees)).toBe(true);
    }

    // nextSteps are human-readable strings
    expect(Array.isArray(data.nextSteps)).toBe(true);
    expect(data.nextSteps.length).toBeGreaterThan(0);
    for (const step of data.nextSteps) {
      expect(typeof step).toBe('string');
    }

    // The query is about MCP tools — mcp.ts should surface as a relevant file
    const allPaths = data.relevantFunctions.map(f => f.filePath);
    const hasMcpFile = allPaths.some(p => p.includes('mcp'));
    expect(hasMcpFile, 'Expected mcp-related file in orient results for MCP tool query').toBe(true);
  });

  // --------------------------------------------------------------------------
  // search_code — hybrid semantic + BM25 code search with graph neighbourhood
  // --------------------------------------------------------------------------

  it('search_code returns ranked results with required fields', async () => {
    if (skip('search_code')) return;

    const resp = await client.callTool('search_code', {
      directory: REPO_ROOT,
      query:     'embed text into vector using embedding service',
      limit:     5,
    });
    const data = client.parseToolResult(resp) as {
      query:      string;
      searchMode: string;
      count:      number;
      results: Array<{
        score:    number;
        name:     string;
        filePath: string;
        language: string;
        fanIn:    number;
        fanOut:   number;
        isHub:    boolean;
      }>;
    };

    expect(data.query).toBe('embed text into vector using embedding service');
    expect(['hybrid', 'bm25_fallback']).toContain(data.searchMode);
    expect(data.count).toBe(data.results.length);
    expect(data.results.length).toBeGreaterThan(0);

    for (const r of data.results) {
      expect(typeof r.name).toBe('string');
      expect(r.name.length).toBeGreaterThan(0);
      expect(typeof r.filePath).toBe('string');
      expect(typeof r.score).toBe('number');
      expect(typeof r.language).toBe('string');
      expect(typeof r.fanIn).toBe('number');
      expect(typeof r.fanOut).toBe('number');
    }

    // Embedding-related files should surface for this query
    const paths = data.results.map(r => r.filePath);
    const hasEmbedFile = paths.some(p => p.includes('embed'));
    expect(hasEmbedFile, 'Expected embedding-related file in search_code results').toBe(true);
  });

  // --------------------------------------------------------------------------
  // RIG-20 — cross-graph spec traversal in search_code and orient
  // --------------------------------------------------------------------------

  it('RIG-20: search_code returns specLinkedFunctions from the same spec domain', async () => {
    if (skip('RIG-20 search_code')) return;

    // Query about embedding: seeds will land in the `analyzer` domain (17 files).
    // spec traversal must find peer functions in that domain not already in results.
    const resp = await client.callTool('search_code', {
      directory: REPO_ROOT,
      query:     'embed text into vector using embedding service',
      limit:     5,
    });
    const data = client.parseToolResult(resp) as {
      results:              Array<{ filePath: string }>;
      specLinkedFunctions?: Array<{ name: string; filePath: string; domain: string; requirement: string }>;
    };

    // specLinkedFunctions only appears when mapping.json exists and seeds have linked specs
    if (!data.specLinkedFunctions) {
      console.warn('[RIG-20] specLinkedFunctions absent — mapping.json may have no entries for this query');
      return;
    }

    expect(Array.isArray(data.specLinkedFunctions)).toBe(true);
    expect(data.specLinkedFunctions.length).toBeGreaterThan(0);

    const seedFiles = new Set(data.results.map(r => r.filePath));
    for (const fn of data.specLinkedFunctions) {
      expect(typeof fn.name).toBe('string');
      expect(typeof fn.filePath).toBe('string');
      expect(typeof fn.domain).toBe('string');
      expect(typeof fn.requirement).toBe('string');
      // spec-linked functions must come from files NOT already in the seed results
      expect(seedFiles.has(fn.filePath), `specLinked fn "${fn.name}" (${fn.filePath}) duplicates a seed result`).toBe(false);
    }
  });

  it('RIG-20: orient returns specLinkedFunctions — two-hop traversal seed→domain→peers', async () => {
    if (skip('RIG-20 orient')) return;

    const resp = await client.callTool('orient', {
      directory: REPO_ROOT,
      task:      'embed text into vector using embedding service',
      limit:     5,
    });
    const data = client.parseToolResult(resp) as {
      relevantFunctions:    Array<{ filePath: string; linkedSpecs: Array<{ domain: string }> }>;
      specLinkedFunctions?: Array<{ name: string; filePath: string; domain: string; requirement: string }>;
    };

    if (!data.specLinkedFunctions) {
      console.warn('[RIG-20] specLinkedFunctions absent — seed functions may have no linkedSpecs');
      return;
    }

    expect(data.specLinkedFunctions.length).toBeGreaterThan(0);

    // All spec-linked domains must have appeared as a linkedSpec of at least one seed
    const seedDomains = new Set(
      data.relevantFunctions.flatMap(fn => fn.linkedSpecs.map(s => s.domain))
    );
    const seedFiles = new Set(data.relevantFunctions.map(fn => fn.filePath));

    for (const fn of data.specLinkedFunctions) {
      expect(seedDomains.has(fn.domain),
        `specLinked fn "${fn.name}" domain "${fn.domain}" not reachable from seed linkedSpecs`
      ).toBe(true);
      // Two-hop: peer files must be outside the direct seed set
      expect(seedFiles.has(fn.filePath),
        `specLinked fn "${fn.name}" (${fn.filePath}) is already a seed — should have been filtered`
      ).toBe(false);
    }
  });

  // --------------------------------------------------------------------------
  // RIG-21 — depth-N expansion: depth-2 adds files not reachable at depth-1
  // (tested via get_subgraph as a proxy: callees of callees exist in the graph)
  // --------------------------------------------------------------------------

  it('RIG-21: depth-2 downstream adds functions not reachable at depth-1 (via analyze_impact)', async () => {
    if (skip('RIG-21')) return;

    // analyze_impact returns downstreamCriticalPath with depth field on each node.
    // openloreRun has 24 depth-1 callees; their callees add 47 more at depth-2 —
    // exactly the files that the old single-hop expansion missed.
    const resp = await client.callTool('analyze_impact', {
      directory: REPO_ROOT,
      symbol:    'openloreRun',
      depth:     2,
    });
    const data = client.parseToolResult(resp) as {
      downstreamCriticalPath: Array<{ name: string; file: string; depth: number }>;
    };

    const depth1 = data.downstreamCriticalPath.filter(n => n.depth === 1);
    const depth2 = data.downstreamCriticalPath.filter(n => n.depth === 2);

    expect(depth1.length).toBeGreaterThan(0);
    expect(depth2.length).toBeGreaterThan(0);

    // Depth-2 nodes are distinct from depth-1 — these are what RIG-21 now adds
    const depth1Names = new Set(depth1.map(n => n.name));
    const newAtDepth2 = depth2.filter(n => !depth1Names.has(n.name));
    expect(newAtDepth2.length, 'Expected depth-2 to add new nodes not reachable at depth-1').toBeGreaterThan(0);

    // And their files are distinct too — confirming new files enter the context
    const depth1Files = new Set(depth1.map(n => n.file));
    const newFilesAtDepth2 = [...new Set(depth2.map(n => n.file))].filter(f => !depth1Files.has(f));
    expect(newFilesAtDepth2.length, 'Expected depth-2 to add new source files').toBeGreaterThan(0);
  });

  // --------------------------------------------------------------------------
  // get_function_body — extracts exact source using call graph byte offsets
  // --------------------------------------------------------------------------

  it('get_function_body returns source body for a known function', async () => {
    if (skip('get_function_body')) return;

    // validateDirectory is a well-known function in the call graph
    const resp = await client.callTool('get_function_body', {
      directory:    REPO_ROOT,
      filePath:     'src/core/services/mcp-handlers/utils.ts',
      functionName: 'validateDirectory',
    });
    const data = client.parseToolResult(resp) as {
      functionName: string;
      filePath:     string;
      language:     string;
      body:         string;
      lineCount:    number;
      startIndex:   number;
      endIndex:     number;
    };

    expect(data.functionName).toBe('validateDirectory');
    expect(data.filePath).toContain('utils.ts');
    expect(data.language).toBeTruthy();
    expect(typeof data.body).toBe('string');
    expect(data.body.length).toBeGreaterThan(10);
    // Body must contain the function name itself
    expect(data.body).toContain('validateDirectory');
    expect(typeof data.lineCount).toBe('number');
    expect(data.lineCount).toBeGreaterThan(0);
    expect(data.endIndex).toBeGreaterThan(data.startIndex);
  });

  // --------------------------------------------------------------------------
  // get_function_skeleton — code shaper: strips bodies, keeps structure
  // --------------------------------------------------------------------------

  it('get_function_skeleton returns reduced skeleton with metadata', async () => {
    if (skip('get_function_skeleton')) return;

    const resp = await client.callTool('get_function_skeleton', {
      directory: REPO_ROOT,
      filePath:  'src/core/analyzer/call-graph.ts',
    });
    const data = client.parseToolResult(resp) as {
      filePath:      string;
      language:      string;
      originalLines: number;
      skeletonLines: number;
      reductionPct:  number;
      worthIncluding: boolean;
      skeleton:      string;
    };

    expect(data.filePath).toContain('call-graph.ts');
    expect(data.language).toBeTruthy();
    expect(data.originalLines).toBeGreaterThan(0);
    expect(data.skeletonLines).toBeGreaterThan(0);
    expect(data.skeletonLines).toBeLessThanOrEqual(data.originalLines);
    expect(data.reductionPct).toBeGreaterThanOrEqual(0);
    expect(data.reductionPct).toBeLessThanOrEqual(100);
    expect(typeof data.skeleton).toBe('string');
    // Skeleton of a large file should meaningfully reduce size
    expect(data.reductionPct).toBeGreaterThan(10);
  });

  // --------------------------------------------------------------------------
  // analyze_impact — blast radius BFS from a known function
  // --------------------------------------------------------------------------

  it('analyze_impact returns upstream/downstream chains for a known hub', async () => {
    if (skip('analyze_impact')) return;

    // 'validateDirectory' is the highest fan-in function — good blast radius test
    const resp = await client.callTool('analyze_impact', {
      directory: REPO_ROOT,
      symbol:    'validateDirectory',
      depth:     2,
    });
    type ImpactResult = {
      symbol:      string;
      file:        string;
      language:    string;
      metrics:     { fanIn: number; fanOut: number; isHub: boolean };
      blastRadius: { total: number; upstream: number; downstream: number };
      riskScore:   number;
      riskLevel:   string;
      upstreamChain:          Array<{ name: string; depth: number }>;
      downstreamCriticalPath: Array<{ name: string; depth: number }>;
      recommendedStrategy:    { approach: string; rationale: string };
    };
    // handleAnalyzeImpact resolves the symbol via FTS, which can match more than
    // one node for a common name. It returns the single result flat, or
    // `{ matches: [...] }` for several — pick the exact-name match either way.
    const raw = client.parseToolResult(resp) as ImpactResult | { matches: ImpactResult[] };
    const data: ImpactResult =
      'matches' in raw
        ? (raw.matches.find(m => m.symbol === 'validateDirectory') ?? raw.matches[0])
        : raw;

    expect(data.symbol).toBe('validateDirectory');
    expect(typeof data.file).toBe('string');
    expect(['TypeScript', 'JavaScript', 'Python', 'Go', 'Rust', 'Ruby', 'Java', 'C++']).toContain(data.language);
    expect(typeof data.metrics.fanIn).toBe('number');
    expect(typeof data.metrics.fanOut).toBe('number');

    // validateDirectory is a hub with callers → upstream chain must be non-empty.
    // (Symbol resolution now prefers the exact match, so this is validateDirectory's
    // own blast radius, not an inflated union with validateDirectoryImpl/Depth.)
    expect(data.blastRadius.upstream).toBeGreaterThan(0);
    expect(data.blastRadius.total).toBeGreaterThan(0);

    expect(['low', 'medium', 'high', 'critical']).toContain(data.riskLevel);
    expect(typeof data.riskScore).toBe('number');
    expect(typeof data.recommendedStrategy.approach).toBe('string');
    expect(typeof data.recommendedStrategy.rationale).toBe('string');

    for (const node of data.upstreamChain) {
      expect(typeof node.name).toBe('string');
      expect(node.depth).toBeGreaterThanOrEqual(1);
      expect(node.depth).toBeLessThanOrEqual(2);
    }
  });

  // --------------------------------------------------------------------------
  // get_god_functions — high fan-out orchestrators
  // --------------------------------------------------------------------------

  it('get_god_functions returns known orchestrators sorted by fanOut', async () => {
    if (skip('get_god_functions')) return;

    const resp = await client.callTool('get_god_functions', {
      directory:        REPO_ROOT,
      fanOutThreshold:  8,
    });
    const data = client.parseToolResult(resp) as {
      threshold:     number;
      count:         number;
      godFunctions:  Array<{ name: string; file: string; fanIn: number; fanOut: number; directCallees: string[]; subgraphNodes: number }>;
    };

    expect(data.threshold).toBe(8);
    expect(data.count).toBe(data.godFunctions.length);
    expect(data.godFunctions.length).toBeGreaterThan(0);

    // Sorted by fanOut descending
    for (let i = 1; i < data.godFunctions.length; i++) {
      expect(data.godFunctions[i].fanOut).toBeLessThanOrEqual(data.godFunctions[i - 1].fanOut);
    }

    for (const fn of data.godFunctions) {
      expect(typeof fn.name).toBe('string');
      expect(typeof fn.file).toBe('string');
      expect(fn.fanOut).toBeGreaterThanOrEqual(8);
      expect(Array.isArray(fn.directCallees)).toBe(true);
      expect(fn.subgraphNodes).toBeGreaterThan(0);
    }

    // The top god function is the highest-fanOut orchestrator. Assert membership
    // in the known-orchestrator set rather than an exact name: the ranking among
    // the top few shifts as the codebase evolves (e.g. handleOrient overtook
    // startMcpServer), and hardcoding one name bit-rots this otherwise-valid check.
    const KNOWN_ORCHESTRATORS = new Set([
      'handleOrient', 'CallGraphBuilder.build', 'dispatchTool', 'startMcpServer',
      'handleStructuralDiff', 'handleDetectChanges', 'configureServer', 'openloreRun',
    ]);
    const top = data.godFunctions[0];
    expect(
      KNOWN_ORCHESTRATORS.has(top.name),
      `top god function "${top.name}" (fanOut ${top.fanOut}) is not a recognized orchestrator`,
    ).toBe(true);
  });

  // --------------------------------------------------------------------------
  // suggest_insertion_points — semantic + graph-expanded insertion candidates
  // --------------------------------------------------------------------------

  it('suggest_insertion_points returns ranked candidates with role and strategy', async () => {
    if (skip('suggest_insertion_points')) return;

    const resp = await client.callTool('suggest_insertion_points', {
      directory:   REPO_ROOT,
      description: 'add rate limiting to MCP tool calls',
      limit:       5,
    });
    const data = client.parseToolResult(resp) as {
      description: string;
      count:       number;
      candidates:  Array<{ rank: number; name: string; filePath: string; role: string; insertionStrategy: string; score: number; reason: string }>;
      nextSteps:   string[];
    };

    expect(data.description).toBe('add rate limiting to MCP tool calls');
    expect(data.count).toBe(data.candidates.length);
    expect(data.candidates.length).toBeGreaterThan(0);

    // Ranks must be 1-based and ascending
    for (let i = 0; i < data.candidates.length; i++) {
      expect(data.candidates[i].rank).toBe(i + 1);
    }

    for (const c of data.candidates) {
      expect(typeof c.name).toBe('string');
      expect(typeof c.filePath).toBe('string');
      expect(typeof c.role).toBe('string');
      expect(typeof c.insertionStrategy).toBe('string');
      expect(typeof c.score).toBe('number');
      expect(typeof c.reason).toBe('string');
    }

    expect(Array.isArray(data.nextSteps)).toBe(true);
    expect(data.nextSteps.length).toBeGreaterThan(0);
  });

  // --------------------------------------------------------------------------
  // list_spec_domains / get_spec / search_specs — spec access chain
  // --------------------------------------------------------------------------

  it('list_spec_domains returns known domains', async () => {
    if (skip('list_spec_domains')) return;

    const resp = await client.callTool('list_spec_domains', { directory: REPO_ROOT });
    const data = client.parseToolResult(resp) as { domains: string[]; count: number };

    expect(Array.isArray(data.domains)).toBe(true);
    expect(data.count).toBe(data.domains.length);
    expect(data.count).toBeGreaterThan(5);

    // Known domains that must exist after openlore runs on itself
    for (const required of ['analyzer', 'api', 'cli', 'llm']) {
      expect(data.domains, `Missing expected spec domain "${required}"`).toContain(required);
    }
  });

  it('get_spec returns spec content and linked functions for a known domain', async () => {
    if (skip('get_spec')) return;

    const resp = await client.callTool('get_spec', { directory: REPO_ROOT, domain: 'analyzer' });
    const data = client.parseToolResult(resp) as {
      domain:          string;
      specFile:        string;
      content:         string;
      linkedFunctions: unknown[] | undefined;
    };

    expect(data.domain).toBe('analyzer');
    expect(data.specFile).toContain('analyzer');
    expect(typeof data.content).toBe('string');
    expect(data.content.length).toBeGreaterThan(100);
    // Spec file must be valid Markdown with at least one heading
    expect(data.content).toMatch(/^#/m);
  });

  it('search_specs returns relevant spec sections for a semantic query', async () => {
    if (skip('search_specs')) return;

    const resp = await client.callTool('search_specs', {
      directory: REPO_ROOT,
      query:     'how the vector index is built and queried',
      limit:     3,
    });

    // search_specs requires the spec index (--embed or --reindex-specs)
    // If the index is missing the handler returns an error object — treat as soft skip
    const raw = client.parseToolResult(resp) as { error?: string; query?: string; count?: number; results?: unknown[] };
    if (raw.error) {
      // Spec index not built — skip gracefully
      console.warn('[search_specs] spec index unavailable:', raw.error);
      return;
    }

    expect(raw.query).toBe('how the vector index is built and queried');
    expect(typeof raw.count).toBe('number');
    expect(Array.isArray(raw.results)).toBe(true);

    const results = raw.results as Array<{ score: number; domain: string; section: string; title: string; text: string }>;
    for (const r of results) {
      expect(typeof r.domain).toBe('string');
      expect(typeof r.section).toBe('string');
      expect(typeof r.title).toBe('string');
      expect(typeof r.text).toBe('string');
      expect(typeof r.score).toBe('number');
    }
  });

  // --------------------------------------------------------------------------
  // trace_execution_path — point-to-point call graph path finder
  //
  // Uses a known 4-hop path in openlore itself:
  //   openloreRun → run → runStage3 → astChunkContent → detectLanguage
  // --------------------------------------------------------------------------

  it('trace_execution_path finds known 4-hop path from openloreRun to detectLanguage', async () => {
    if (skip('trace_execution_path')) return;

    const resp = await client.callTool('trace_execution_path', {
      directory:      REPO_ROOT,
      entryFunction:  'openloreRun',
      targetFunction: 'detectLanguage',
      maxDepth:       6,
      maxPaths:       10,
    });
    const data = client.parseToolResult(resp) as {
      entryFunction:  string;
      targetFunction: string;
      pathsFound:     number;
      maxDepth:       number;
      shortestPath?:  string;
      shortestPathFound?: string;
      paths: Array<{
        hops:  number;
        chain: string;
        steps: Array<{ name: string; file: string; className: string | null }>;
      }>;
    };

    expect(data.entryFunction).toBe('openloreRun');
    expect(data.targetFunction).toBe('detectLanguage');
    expect(data.pathsFound).toBeGreaterThan(0);
    expect(data.maxDepth).toBe(6);

    // Shortest path must end with detectLanguage. The key is `shortestPathFound` when
    // enumeration stopped at maxPaths — the field is renamed precisely because it can
    // no longer claim to be the global shortest — so accept either spelling.
    expect(data.shortestPath ?? data.shortestPathFound).toMatch(/detectLanguage$/);

    // Known path must be ≤ 4 hops
    expect(data.paths[0].hops).toBeLessThanOrEqual(4);

    // Paths are ordered by hops ascending (shortest first)
    for (let i = 1; i < data.paths.length; i++) {
      expect(data.paths[i].hops).toBeGreaterThanOrEqual(data.paths[i - 1].hops);
    }

    // Each path has valid step objects
    for (const path of data.paths) {
      expect(typeof path.hops).toBe('number');
      expect(path.hops).toBeGreaterThan(0);
      expect(typeof path.chain).toBe('string');
      expect(path.steps.length).toBe(path.hops + 1);
      for (const step of path.steps) {
        expect(typeof step.name).toBe('string');
        expect(step.name.length).toBeGreaterThan(0);
        expect(typeof step.file).toBe('string');
      }
      // First step is always the entry, last is always the target
      expect(path.steps[0].name).toBe('openloreRun');
      expect(path.steps[path.steps.length - 1].name).toBe('detectLanguage');
    }
  });

  it('trace_execution_path returns pathsFound: 0 with hint for disconnected functions', async () => {
    if (skip('trace_execution_path — no path')) return;

    // validateDirectory has fanIn=24 but fanOut=0 — nothing downstream from it
    const resp = await client.callTool('trace_execution_path', {
      directory:      REPO_ROOT,
      entryFunction:  'validateDirectory',
      targetFunction: 'startMcpServer',   // reverse direction — unreachable
      maxDepth:       3,
    });
    const data = client.parseToolResult(resp) as {
      pathsFound: number;
      hint?:      string;
      message?:   string;
    };

    expect(data.pathsFound).toBe(0);
    expect(data.hint ?? data.message).toBeTruthy();
  });

  // --------------------------------------------------------------------------
  // Concurrent requests — verifies id correlation (server must not mix up
  // responses when two requests are in flight simultaneously)
  // --------------------------------------------------------------------------

  it('concurrent tool calls return correctly correlated responses', async () => {
    if (skip('concurrent calls')) return;

    const [respA, respB] = await Promise.all([
      client.callTool('get_critical_hubs', { directory: REPO_ROOT, minFanIn: 3 }),
      client.callTool('get_leaf_functions', { directory: REPO_ROOT }),
    ]);

    const hubData  = client.parseToolResult(respA) as { hubs: unknown[] };
    const leafData = client.parseToolResult(respB) as { leaves: unknown[] };

    expect(Array.isArray(hubData.hubs)).toBe(true);
    expect(Array.isArray(leafData.leaves)).toBe(true);
    // Each request must have its own id (they differ by 1)
    expect(Math.abs((respA.id as number) - (respB.id as number))).toBe(1);
  });

  // --------------------------------------------------------------------------
  // Error handling — invalid directory must return isError:true, not crash
  // --------------------------------------------------------------------------

  it('invalid directory returns isError response without crashing server', async () => {
    if (skip('error handling')) return;

    const resp = await client.callTool('get_call_graph', {
      directory: '/this/path/does/not/exist',
    });

    expect(resp.result?.isError).toBe(true);
    const text = resp.result!.content[0]?.text ?? '';
    expect(text.length).toBeGreaterThan(0);
    // Server must still respond to subsequent requests after an error
    const ok = await client.callTool('get_critical_hubs', { directory: REPO_ROOT, minFanIn: 10 });
    expect(ok.result?.isError).toBeFalsy();
  });
});
