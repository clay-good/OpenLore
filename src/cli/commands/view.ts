/**
 * openlore view command
 *
 * Starts a local React (Vite) server to visualize analysis graphs,
 * then opens the user's browser.
 */

import { Command } from 'commander';
import { withRelaxedTls } from '../../core/services/tls-scope.js';
import { readFile, unlink } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { fileExists } from '../../utils/command-helpers.js';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { logger } from '../../utils/logger.js';
import { safeJoin } from '../../utils/path-confinement.js';
import { isLoopbackHost } from '../../utils/loopback.js';
import {
  MAX_QUERY_LENGTH,
  MAX_CHAT_BODY_BYTES,
  DEFAULT_VIEWER_PORT,
  DEFAULT_VIEWER_HOST,
  OPENLORE_DIR,
  OPENLORE_ANALYSIS_REL_PATH,
  OPENSPEC_DIR,
  OPENSPEC_SPECS_SUBDIR,
  ARTIFACT_DEPENDENCY_GRAPH,
  ARTIFACT_LLM_CONTEXT,
  ARTIFACT_REFACTOR_PRIORITIES,
  ARTIFACT_MAPPING,
} from '../../constants.js';
import {
  createApiGuardMiddleware,
  createBrowserSessionGuard,
  writeInstanceDescriptor,
} from './local-http-guard.js';
import { VectorIndex } from '../../core/analyzer/vector-index.js';
import { resolveEmbedder } from '../../core/analyzer/embedder.js';
import { getSkeletonContent } from '../../core/analyzer/code-shaper.js';
import { detectLanguage } from '../../core/analyzer/language-detection.js';
import { runChatAgent, resolveProviderConfig } from '../../core/services/chat-agent.js';

/** Strip internal filesystem paths and API keys from error messages before sending to clients. */
export function sanitizeErrorMessage(msg: string): string {
  return msg
    .replace(/\/Users\/[^\s:]+/g, '[path]')
    .replace(/\/home\/[^\s:]+/g, '[path]')
    .replace(/[A-Z]:\\[^\s:]+/g, '[path]')
    .replace(/[?&]key=[A-Za-z0-9\-_]{10,}/g, '?key=[REDACTED]')
    .replace(/sk-ant-[A-Za-z0-9\-_]{10,}/g, '[REDACTED]')
    .replace(/sk-[A-Za-z0-9\-_]{20,}/g, '[REDACTED]')
    .replace(/Bearer\s+\S{10,}/g, 'Bearer [REDACTED]')
    .replace(/x-api-key:\s*\S{10,}/gi, 'x-api-key: [REDACTED]');
}

/**
 * Ensure a resolved path stays within the project root. Returns null if invalid.
 *
 * Delegates to the shared `safeJoin` so this surface gets the same SYMLINK-aware
 * containment the MCP handlers have (mcp-security: Symlink-Aware Path Confinement).
 * The lexical-only check this used to do accepted an in-repo symlink pointing
 * outside the root, which the `/api/skeleton` and `/api/spec-requirements` routes
 * would then read.
 */
export function safePath(rootPath: string, userPath: string): string | null {
  try {
    return safeJoin(resolve(rootPath), userPath);
  } catch {
    return null;
  }
}

function openBrowser(url: string): void {
  const platform = process.platform;
  const cmd = platform === 'darwin' ? 'open' : platform === 'win32' ? 'cmd' : 'xdg-open';

  const args = platform === 'win32' ? ['/c', 'start', '', url] : [url];

  const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
  child.unref();
}

export const viewCommand = new Command('view')
  .description('Start an interactive graph viewer (React) for .openlore/analysis')
  .option('--analysis <path>', 'Path to analysis directory', `${OPENLORE_ANALYSIS_REL_PATH}/`)
  .option('--spec <path>', 'Path to spec files directory', `./${OPENSPEC_DIR}/${OPENSPEC_SPECS_SUBDIR}/`)
  .option('--port <n>', 'Port to run the viewer on', String(DEFAULT_VIEWER_PORT))
  .option('--host <host>', 'Host to bind (default loopback; every route requires the one-time link)', DEFAULT_VIEWER_HOST)
  .option('--no-open', 'Do not open the browser automatically', false)
  .action(
    async (options: {
      analysis: string;
      spec: string;
      port: string;
      host: string;
      open: boolean;
    }) => {
      const rootPath = process.cwd();
      const analysisDir = resolve(rootPath, options.analysis);
      const graphPath = join(analysisDir, ARTIFACT_DEPENDENCY_GRAPH);
      const llmContextPath = join(analysisDir, ARTIFACT_LLM_CONTEXT);
      const refactorPath = join(analysisDir, ARTIFACT_REFACTOR_PRIORITIES);
      const mappingPath = join(analysisDir, ARTIFACT_MAPPING);
      const specDir = resolve(rootPath, options.spec);

      if (!(await fileExists(graphPath))) {
        logger.error(`Missing graph file: ${graphPath}`);
        logger.info('Tip', 'Run "openlore analyze" first (or pass --analysis)');
        process.exitCode = 1;
        return;
      }

      const here = fileURLToPath(new URL('.', import.meta.url));
      const candidateA = resolve(join(here, '../../viewer/app')); // when running from src/cli/commands
      const candidateB = resolve(join(here, '../../../src/viewer/app')); // when running from dist/cli/commands
      const viewerRoot = await fileExists(join(candidateA, 'index.html')) ? candidateA : candidateB;

      if (!(await fileExists(join(viewerRoot, 'index.html')))) {
        logger.error(
          `Viewer assets not found (expected index.html). Tried: ${candidateA} and ${candidateB}`
        );
        process.exitCode = 1;
        return;
      }

      const parsedPort = Number.parseInt(options.port, 10);
      if (options.port && (isNaN(parsedPort) || parsedPort < 1 || parsedPort > 65535)) {
        logger.error('--port must be a number between 1 and 65535');
        process.exitCode = 1;
        return;
      }
      const port = isNaN(parsedPort) ? DEFAULT_VIEWER_PORT : parsedPort;
      const host = options.host || DEFAULT_VIEWER_HOST;

      // A non-loopback bind is now the same posture as `serve`: the token is required
      // on every route (below), and the page no longer contains it — so binding a
      // container interface for a published port is safe as long as the operator keeps
      // the one-time URL to themselves. Warn, rather than refuse.
      if (!isLoopbackHost(host)) {
        logger.warning(
          `Binding non-loopback host "${host}": anyone who can reach this port needs the ` +
            `one-time link below to use the viewer. Treat that URL as a password.`,
        );
      }

      // Per-instance token. Injected into the served UI so its same-origin /api
      // requests authenticate; required by the money/agent chat route (always)
      // and by every route when bound to a non-loopback host. See local-http-guard.ts.
      const token = randomBytes(24).toString('hex');

      logger.section('Starting Graph Viewer');
      logger.info('Analysis', analysisDir);
      logger.info('Graph', graphPath);

      // Dynamic imports — vite and @vitejs/plugin-react are only needed for `openlore view`,
      // so we load them at runtime to avoid ERR_MODULE_NOT_FOUND for other commands (#24).
      const { createServer } = await import('vite');
      const { default: react } = await import('@vitejs/plugin-react');

      const server = await createServer({
        root: viewerRoot,
        logLevel: 'error',
        plugins: [
          react(),
          {
            name: 'openlore-graph-api',
            configureServer(devServer) {
              // SECURITY, first gate: EVERY route, including `/` and its assets. This
              // is what stops another local process from simply fetching the page. It
              // also performs the one-time ?token= → HttpOnly-cookie handshake that
              // lets the browser in; see createBrowserSessionGuard.
              devServer.middlewares.use(
                createBrowserSessionGuard({ boundHost: host, token }),
              );

              // SECURITY, second gate: one guard in front of every /api/* route.
              // Redundant with the session guard for authentication, kept because it
              // is the shared policy both local surfaces apply (mcp-security:
              // AllLocalHttpSurfacesShareTheGuard) and it keeps `serve` and `view`
              // from drifting.
              devServer.middlewares.use(
                '/api',
                createApiGuardMiddleware({
                  boundHost: host,
                  token,
                  requireTokenFor: (rel) => rel === '/chat',
                }),
              );

              devServer.middlewares.use('/api/dependency-graph', async (_req, res) => {
                try {
                  // Friendly 404 (matching the sibling artifact endpoints) when the graph
                  // was removed/renamed after server start, rather than a 500 on ENOENT.
                  if (!(await fileExists(graphPath))) {
                    res.statusCode = 404;
                    res.end(JSON.stringify({ error: 'dependency-graph.json not found — run "openlore analyze"' }));
                    return;
                  }
                  const json = await readFile(graphPath, 'utf-8');
                  res.setHeader('Content-Type', 'application/json; charset=utf-8');
                  res.statusCode = 200;
                  res.end(json);
                } catch (err) {
                  res.statusCode = 500;
                  res.end(JSON.stringify({ error: sanitizeErrorMessage((err as Error).message) }));
                }
              });

              devServer.middlewares.use('/api/llm-context', async (_req, res) => {
                try {
                  if (!(await fileExists(llmContextPath))) {
                    res.statusCode = 404;
                    res.end(JSON.stringify({ error: 'llm-context.json not found' }));
                    return;
                  }
                  const json = await readFile(llmContextPath, 'utf-8');
                  res.setHeader('Content-Type', 'application/json; charset=utf-8');
                  res.statusCode = 200;
                  res.end(json);
                } catch (err) {
                  res.statusCode = 500;
                  res.end(JSON.stringify({ error: sanitizeErrorMessage((err as Error).message) }));
                }
              });

              devServer.middlewares.use('/api/class-graph', async (_req, res) => {
                try {
                  if (!(await fileExists(llmContextPath))) {
                    res.statusCode = 404;
                    res.end(JSON.stringify({ error: 'llm-context.json not found' }));
                    return;
                  }
                  const raw = JSON.parse(await readFile(llmContextPath, 'utf-8')) as {
                    callGraph?: { classes?: unknown[]; inheritanceEdges?: unknown[]; edges?: unknown[]; nodes?: unknown[] };
                  };
                  const cg = raw.callGraph ?? {};
                  res.setHeader('Content-Type', 'application/json; charset=utf-8');
                  res.statusCode = 200;
                  res.end(JSON.stringify({
                    classes:         cg.classes         ?? [],
                    inheritanceEdges: cg.inheritanceEdges ?? [],
                    edges:           cg.edges            ?? [],
                    nodes:           cg.nodes            ?? [],
                  }));
                } catch (err) {
                  res.statusCode = 500;
                  res.end(JSON.stringify({ error: sanitizeErrorMessage((err as Error).message) }));
                }
              });

              devServer.middlewares.use('/api/refactor-priorities', async (_req, res) => {
                try {
                  if (!(await fileExists(refactorPath))) {
                    res.statusCode = 404;
                    res.end(JSON.stringify({ error: 'refactor-priorities.json not found' }));
                    return;
                  }
                  const json = await readFile(refactorPath, 'utf-8');
                  res.setHeader('Content-Type', 'application/json; charset=utf-8');
                  res.statusCode = 200;
                  res.end(json);
                } catch (err) {
                  res.statusCode = 500;
                  res.end(JSON.stringify({ error: sanitizeErrorMessage((err as Error).message) }));
                }
              });

              devServer.middlewares.use('/api/mapping', async (_req, res) => {
                try {
                  if (!(await fileExists(mappingPath))) {
                    res.statusCode = 404;
                    res.end(JSON.stringify({ error: 'mapping.json not found' }));
                    return;
                  }
                  const json = await readFile(mappingPath, 'utf-8');
                  res.setHeader('Content-Type', 'application/json; charset=utf-8');
                  res.statusCode = 200;
                  res.end(json);
                } catch (err) {
                  res.statusCode = 500;
                  res.end(JSON.stringify({ error: sanitizeErrorMessage((err as Error).message) }));
                }
              });

              devServer.middlewares.use('/api/spec', async (_req, res) => {
                try {
                  if (!(await fileExists(specDir))) {
                    res.statusCode = 404;
                    res.end(JSON.stringify({ error: 'spec directory not found' }));
                    return;
                  }

                  // Recursively read all spec files and concatenate them
                  const { readdirSync, statSync } = await import('node:fs');

                  const collectSpecFiles = (dir: string): string[] => {
                    const files: string[] = [];
                    try {
                      const entries = readdirSync(dir);
                      for (const entry of entries) {
                        if (entry.startsWith('.')) continue;
                        const fullPath = join(dir, entry);
                        const stat = statSync(fullPath);
                        if (stat.isDirectory()) {
                          files.push(...collectSpecFiles(fullPath));
                        } else if (entry.endsWith('.md')) {
                          files.push(fullPath);
                        }
                      }
                    } catch {
                      // ignore errors in subdirectories
                    }
                    return files;
                  };

                  const specFiles = collectSpecFiles(specDir).sort();
                  let combinedSpec = '';

                  for (const filePath of specFiles) {
                    try {
                      const content = await readFile(filePath, 'utf-8');
                      combinedSpec += content + '\n\n';
                    } catch {
                      // skip files that can't be read
                    }
                  }

                  res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
                  res.statusCode = 200;
                  res.end(combinedSpec);
                } catch (err) {
                  res.statusCode = 500;
                  res.end(JSON.stringify({ error: sanitizeErrorMessage((err as Error).message) }));
                }
              });

              devServer.middlewares.use('/api/spec-requirements', async (_req, res) => {
                try {
                  if (!(await fileExists(mappingPath))) {
                    res.statusCode = 404;
                    res.end(JSON.stringify({ error: 'mapping.json not found' }));
                    return;
                  }

                  // Read mapping to get spec file references
                  const mappingContent = await readFile(mappingPath, 'utf-8');
                  const mapping = JSON.parse(mappingContent);

                  // We'll build a requirements object keyed by the exact mapping.requirement value.
                  // For each mapping entry we read the exact specFile referenced and extract the
                  // Requirement block whose title matches the mapping.requirement (case-insensitive).
                  const requirements: Record<
                    string,
                    {
                      title: string;
                      body: string;
                      specFile?: string;
                      domain?: string;
                      service?: string;
                    }
                  > = {};

                  for (const m of mapping.mappings || []) {
                    const reqName = m.requirement;
                    const specFileRel = m.specFile;
                    if (!specFileRel || !reqName) continue;

                    const specFileAbs = safePath(rootPath, specFileRel);
                    if (!specFileAbs || !(await fileExists(specFileAbs))) continue;

                    try {
                      const content = await readFile(specFileAbs, 'utf-8');

                      // Split into Requirement sections and find the one that matches reqName exactly
                      // We will compare titles case-insensitively but otherwise match the title text directly.
                      const sections = content.split(/^#{3,4}\s+Requirement:\s*/m);
                      let found = false;
                      for (let i = 1; i < sections.length; i++) {
                        const lines = sections[i].split('\n');
                        const rawTitle = lines[0].trim();
                        if (rawTitle.length === 0) continue;

                        // Deterministic match: case-insensitive equality
                        if (rawTitle.toLowerCase() === reqName.toLowerCase()) {
                          const body = lines.slice(1).join('\n').trim();
                          requirements[reqName] = {
                            title: rawTitle,
                            body,
                            specFile: specFileRel,
                            domain: m.domain,
                            service: m.service,
                          };
                          found = true;
                          break;
                        }
                      }

                      // If not found by exact-title match, do not attempt fuzzy heuristics.
                      // Instead, add an empty placeholder so the client knows we attempted to load it.
                      if (!found) {
                        requirements[reqName] = {
                          title: reqName,
                          body: '',
                          specFile: specFileRel,
                          domain: m.domain,
                          service: m.service,
                        };
                      }
                    } catch {
                      // If file cannot be read, store a missing placeholder
                      requirements[m.requirement] = {
                        title: m.requirement,
                        body: '',
                        specFile: specFileRel,
                        domain: m.domain,
                        service: m.service,
                      };
                    }
                  }

                  res.setHeader('Content-Type', 'application/json; charset=utf-8');
                  res.statusCode = 200;
                  res.end(JSON.stringify(requirements));
                } catch (err) {
                  res.statusCode = 500;
                  res.end(JSON.stringify({ error: sanitizeErrorMessage((err as Error).message) }));
                }
              });

              devServer.middlewares.use('/api/skeleton', async (req, res) => {
                try {
                  const url = new URL(req.url ?? '', 'http://localhost');
                  const file = url.searchParams.get('file')?.trim() ?? '';
                  if (!file) {
                    res.statusCode = 400;
                    res.end(JSON.stringify({ error: 'Missing ?file=' }));
                    return;
                  }
                  const absFile = safePath(rootPath, file);
                  if (!absFile) {
                    res.statusCode = 403;
                    res.end(JSON.stringify({ error: 'Access denied: path outside project' }));
                    return;
                  }
                  const source = await readFile(absFile, 'utf-8');
                  const language = detectLanguage(file);
                  const skeleton = getSkeletonContent(source, language);
                  res.setHeader('Content-Type', 'application/json; charset=utf-8');
                  res.statusCode = 200;
                  res.end(JSON.stringify({
                    filePath: file,
                    language,
                    originalLines: source.split('\n').length,
                    skeletonLines: skeleton.split('\n').length,
                    reductionPct: Math.round((1 - skeleton.length / source.length) * 100),
                    skeleton,
                  }));
                } catch (err) {
                  res.statusCode = 404;
                  res.end(JSON.stringify({ error: sanitizeErrorMessage((err as Error).message) }));
                }
              });

              devServer.middlewares.use('/api/chat', async (req, res, next) => {
                // Only handle the exact /api/chat path -- let sub-paths (e.g. /models) fall through
                if (req.url && req.url !== '/' && req.url !== '') { next(); return; }
                if (req.method !== 'POST') {
                  res.statusCode = 405;
                  res.end(JSON.stringify({ error: 'Method not allowed' }));
                  return;
                }
                try {
                  // Collect body chunks with size limit
                  const chunks: Buffer[] = [];
                  let totalBytes = 0;
                  await new Promise<void>((resolve, reject) => {
                    req.on('data', (chunk: Buffer) => {
                      totalBytes += chunk.length;
                      if (totalBytes > MAX_CHAT_BODY_BYTES) {
                        req.destroy();
                        reject(new Error('Request body too large'));
                        return;
                      }
                      chunks.push(chunk);
                    });
                    req.on('end', resolve);
                    req.on('error', reject);
                  });
                  const body = JSON.parse(Buffer.concat(chunks).toString('utf-8')) as {
                    message: string;
                    history?: { role: 'user' | 'assistant'; content: string }[];
                    model?: string;
                  };

                  if (!body.message || typeof body.message !== 'string') {
                    res.statusCode = 400;
                    res.end(JSON.stringify({ error: 'Missing "message" field' }));
                    return;
                  }

                  const history = Array.isArray(body.history) ? body.history.slice(-50) : [];
                  const modelOverride = typeof body.model === 'string' ? body.model : undefined;

                  // Build pathToNodeId from the dependency graph on-demand.
                  // Raw dependency-graph.json nodes have the shape { id, file: { path } }.
                  // Tool results return paths relative to rootPath or absolute -- normalise both.
                  const normalise = (p: string) =>
                    p.startsWith(rootPath) ? p.slice(rootPath.length).replace(/^\/+/, '') : p.replace(/^\/+/, '');
                  const pathToNodeId: Map<string, string> = new Map();
                  try {
                    const graphRaw = await readFile(graphPath, 'utf-8');
                    const graph = JSON.parse(graphRaw) as {
                      nodes?: Array<{ id?: string; file?: { path?: string } }>;
                    };
                    for (const n of graph.nodes ?? []) {
                      if (!n.id || !n.file?.path) continue;
                      pathToNodeId.set(normalise(n.file.path), n.id);
                    }
                  } catch { /* graph not available */ }

                  // Use SSE so the client sees tool_start/tool_end events in real time.
                  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
                  res.setHeader('Cache-Control', 'no-cache');
                  res.setHeader('Connection', 'keep-alive');
                  res.statusCode = 200;

                  // Abort the agent loop when the client disconnects
                  const abortController = new AbortController();
                  req.on('close', () => abortController.abort());

                  const sendEvent = (data: object) => {
                    if (abortController.signal.aborted) return;
                    res.write(`data: ${JSON.stringify(data)}\n\n`);
                    // Flush immediately so SSE events reach the client without buffering
                    (res as unknown as { flush?: () => void }).flush?.();
                  };

                  const { reply, filePaths } = await runChatAgent({
                    directory: rootPath,
                    messages: [...history, { role: 'user', content: body.message }],
                    modelOverride,
                    signal: abortController.signal,
                    onToolStart: (name) => sendEvent({ type: 'tool_start', name }),
                    onToolEnd:   (name) => sendEvent({ type: 'tool_end',   name }),
                  });

                  if (abortController.signal.aborted) return;

                  const highlightIds: string[] = [];
                  const highlightPaths: string[] = [];
                  for (const p of filePaths) {
                    const id = pathToNodeId.get(normalise(p));
                    if (id) { highlightIds.push(id); highlightPaths.push(p); }
                  }

                  sendEvent({ type: 'reply', reply, highlightIds, filePaths: highlightPaths });
                  res.end();
                } catch (err) {
                  // If headers already sent (SSE started), send error event; otherwise plain JSON.
                  if (res.headersSent) {
                    res.write(`data: ${JSON.stringify({ type: 'error', error: sanitizeErrorMessage((err as Error).message) })}\n\n`);
                    res.end();
                  } else {
                    res.statusCode = 500;
                    res.end(JSON.stringify({ error: sanitizeErrorMessage((err as Error).message) }));
                  }
                }
              });

              devServer.middlewares.use('/api/chat/models', async (req, res) => {
                try {
                  const cfg = await resolveProviderConfig(rootPath);
                  res.setHeader('Content-Type', 'application/json; charset=utf-8');

                  const modelTimeout = AbortSignal.timeout(10_000);
                  let models: string[] = [];
                  if (cfg.kind === 'gemini') {
                    const r = await withRelaxedTls(() => fetch(
                      `https://generativelanguage.googleapis.com/v1beta/models?key=${cfg.apiKey}`,
                      { signal: modelTimeout }
                    ));
                    if (r.ok) {
                      const data = await r.json() as { models?: Array<{ name: string; supportedGenerationMethods?: string[] }> };
                      models = (data.models ?? [])
                        .filter(m => m.supportedGenerationMethods?.includes('generateContent'))
                        .map(m => m.name.replace('models/', ''));
                    }
                  } else if (cfg.kind === 'anthropic') {
                    const r = await withRelaxedTls(() => fetch(`${cfg.baseUrl}/models`, {
                      headers: { 'x-api-key': cfg.apiKey, 'anthropic-version': '2023-06-01' },
                      signal: modelTimeout,
                    }));
                    if (r.ok) {
                      const data = await r.json() as { data?: Array<{ id: string }> };
                      models = (data.data ?? []).map(m => m.id);
                    }
                  } else {
                    // Unconfigured fallback (no key + the default OpenAI base) means the
                    // user never set a provider — don't fire an unauthenticated request at
                    // api.openai.com (which 401s and looks like "zero models"). A genuine
                    // local provider has a custom baseUrl, so it still lists models keylessly.
                    if (!cfg.apiKey && cfg.baseUrl === 'https://api.openai.com/v1') {
                      res.statusCode = 200;
                      res.end(JSON.stringify({
                        provider: cfg.kind, currentModel: cfg.model, models: [],
                        error: 'No LLM provider configured — set an API key (ANTHROPIC_API_KEY / OPENAI_API_KEY / GEMINI_API_KEY) or OPENAI_COMPAT_BASE_URL.',
                      }));
                      return;
                    }
                    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
                    if (cfg.apiKey) headers['Authorization'] = `Bearer ${cfg.apiKey}`;
                    const r = await withRelaxedTls(() => fetch(`${cfg.baseUrl}/models`, { headers, signal: modelTimeout }));
                    if (r.ok) {
                      const data = await r.json() as { data?: Array<{ id: string }> };
                      models = (data.data ?? []).map(m => m.id).sort();
                    }
                  }

                  res.statusCode = 200;
                  res.end(JSON.stringify({ provider: cfg.kind, currentModel: cfg.model, models }));
                } catch (err) {
                  // Sanitize BEFORE logging: the gemini path puts the API key in the
                  // request URL (?key=...), and fetch errors embed the URL — so the raw
                  // message can carry the key into the server console/log.
                  const safe = sanitizeErrorMessage((err as Error).message);
                  logger.error(`[chat/models] error: ${safe}`);
                  res.statusCode = 500;
                  res.end(JSON.stringify({ error: safe }));
                }
              });

              devServer.middlewares.use('/api/search', async (req, res) => {
                try {
                  const url = new URL(req.url ?? '', 'http://localhost');
                  const q = url.searchParams.get('q')?.trim() ?? '';
                  if (!q) {
                    res.statusCode = 400;
                    res.end(JSON.stringify({ error: 'Missing query parameter ?q=' }));
                    return;
                  }
                  if (q.length > MAX_QUERY_LENGTH) {
                    res.statusCode = 400;
                    res.end(JSON.stringify({ error: `Query too long (max ${MAX_QUERY_LENGTH} chars)` }));
                    return;
                  }
                  if (!VectorIndex.exists(analysisDir)) {
                    res.statusCode = 404;
                    res.end(JSON.stringify({ error: 'No vector index found. Run openlore analyze --embed first.' }));
                    return;
                  }
                  const { readOpenLoreConfig } = await import('../../core/services/config-manager.js');
                  const embedSvc = await resolveEmbedder(await readOpenLoreConfig(rootPath));
                  const results = await VectorIndex.search(analysisDir, q, embedSvc, { limit: 5 });
                  res.setHeader('Content-Type', 'application/json; charset=utf-8');
                  res.statusCode = 200;
                  res.end(JSON.stringify(results.map(r => ({
                    id: r.record.id,
                    name: r.record.name,
                    filePath: r.record.filePath,
                    language: r.record.language,
                    score: r.score,
                  }))));
                } catch (err) {
                  res.statusCode = 500;
                  res.end(JSON.stringify({ error: sanitizeErrorMessage((err as Error).message) }));
                }
              });
            },
          },
        ],
        server: {
          port,
          host,
          strictPort: true,
        },
      });

      try {
        await server.listen();
      } catch (err) {
        const msg = (err as Error).message;
        if (/EADDRINUSE|address already in use/i.test(msg)) {
          logger.error(`Port ${port} is already in use. Start the viewer on another port: openlore view --port <n>`);
        } else {
          logger.error(`Failed to start the viewer: ${msg}`);
        }
        process.exitCode = 1;
        return;
      }

      // The one-time link. It carries the token exactly once: opening it exchanges the
      // token for an HttpOnly cookie and redirects to the bare URL, so the token does
      // not linger in the address bar, in history, or in a Referer header.
      const url = `http://${host}:${port}/`;
      const entryUrl = `${url}?token=${token}`;
      logger.success(`Viewer running at ${url}`);
      logger.info('Open this link', entryUrl);
      logger.info('Note', 'the link is the credential — anyone who has it can use this viewer');

      // Discovery + stale-instance detection (parity with the `serve` daemon):
      // record where the viewer is listening so a later invocation / tool can
      // detect a live or stale instance instead of a mystery port occupant.
      const descriptorPath = join(rootPath, OPENLORE_DIR, 'view.json');
      try {
        // 0600 — the descriptor carries the instance token that gates /api/chat.
        await writeInstanceDescriptor(descriptorPath, {
          port,
          pid: process.pid,
          host,
          token,
          startedAt: new Date().toISOString(),
        });
      } catch {
        // Discovery is best-effort; a read-only .openlore must not stop the viewer.
      }

      // Graceful shutdown: close the server and drop the descriptor so a stale
      // view.json never outlives the process (parity with `serve`).
      let shuttingDown = false;
      const shutdown = async (): Promise<void> => {
        if (shuttingDown) return;
        shuttingDown = true;
        await unlink(descriptorPath).catch(() => {});
        await server.close().catch(() => {});
        process.exit(0);
      };
      process.on('SIGINT', () => void shutdown());
      process.on('SIGTERM', () => void shutdown());

      if (options.open) {
        openBrowser(entryUrl);
      }

      // Vite keeps the event loop alive; nothing else to do here.
    }
  );
