import {
  CONFIGURATION_SURVEY_BUDGET,
  CONFIGURATION_HARD_BUDGET,
  CONFIGURATION_SOURCE,
  CONFIGURATION_PRUNED,
} from '../../constants.js';
import { opendir, realpath, stat } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { spawnGit } from '../../utils/git-exec.js';
import { gitPathArgs } from '../../utils/git-args.js';
import ignoreModule from 'ignore';
import { parse as parseJson } from 'jsonc-parser';
import { globalOpenLoreConfigPath, mergeConfigLayers } from '../../utils/config-layers.js';
import {
  readFileConfined,
  readFileConfinedWithStat,
  safeJoin,
} from '../../utils/path-confinement.js';
import { validateOpenLoreConfig, isFatalConfigFinding } from '../services/config-schema.js';
import { redactSecrets } from '../services/secret-redaction.js';
import {
  validateServeDescriptor,
  validateServeHealth,
  serveHttpBaseUrl,
} from '../../cli/commands/serve-descriptor.js';
import { OPENLORE_CONFIG_REL_PATH, OPENLORE_ANALYSIS_REL_PATH } from '../../constants.js';
import {
  configurationDigest,
  FilePolicyResolver,
  repositoryPath,
  validPolicyPattern,
  validateFilePolicies,
} from './policy.js';
import type {
  ConfigurationDisclosure,
  ConfigurationEvidence,
  ConfigurationInspection,
  ConfigurationOptions,
  ConfigurationRecommendation,
  FilePolicies,
} from './types.js';

const ignore =
  (ignoreModule as typeof ignoreModule & { default?: typeof ignoreModule }).default ?? ignoreModule;
const DECLARATIVE = new Set([
  'package.json',
  'tsconfig.json',
  'Cargo.toml',
  'config.toml',
  'pyproject.toml',
  'go.mod',
  'pom.xml',
  'build.gradle',
  'settings.gradle',
  'pnpm-workspace.yaml',
  '.gitignore',
  '.openlore-ignore',
]);

export async function readConfiguration(options: ConfigurationOptions) {
  options.signal?.throwIfAborted();
  const root = await realpath(options.rootPath ?? process.cwd());
  const configPath = safeJoin(
    root,
    options.configPath ? resolve(root, options.configPath) : OPENLORE_CONFIG_REL_PATH
  );
  let text = '';
  let identity: Awaited<ReturnType<typeof readFileConfinedWithStat>>['stat'] | null = null;
  let raw: Record<string, unknown> = {};
  let malformed = false;
  try {
    const read = await readFileConfinedWithStat(
      root,
      configPath,
      CONFIGURATION_HARD_BUDGET.fileBytes,
      true
    );
    text = read.content;
    identity = read.stat;
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      throw new Error('not an object');
    raw = parsed as Record<string, unknown>;
    if (
      validateOpenLoreConfig(raw).some(
        (f) => f.kind !== 'missing-required' && isFatalConfigFinding(f)
      )
    )
      malformed = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') malformed = true;
  }
  let user: Record<string, unknown> = {};
  let globalRevision = 'absent';
  let globalUnreadable = false;
  const userPath = globalOpenLoreConfigPath();
  try {
    const content = await readFileConfined(
      dirname(userPath),
      basename(userPath),
      CONFIGURATION_HARD_BUDGET.fileBytes,
      true
    );
    globalRevision = configurationDigest(content);
    const parsed: unknown = JSON.parse(content);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      throw new Error('not an object');
    user = parsed as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') globalUnreadable = true;
  }
  const effective = mergeConfigLayers(user, raw);
  const policies = effective.filePolicies as FilePolicies | undefined;
  const policyErrors = policies ? validateFilePolicies(policies) : [];
  return {
    root,
    configPath,
    text,
    identity,
    raw,
    effective,
    malformed,
    globalUnreadable,
    globalRevision,
    revision: configurationDigest({
      present: identity !== null,
      text,
      globalRevision,
      globalUnreadable,
    }),
    policyErrors,
    resolver: new FilePolicyResolver(
      policyErrors.length ? undefined : policies,
      options.protectedExcludePatterns
    ),
  };
}

/** Bounded stream; never invoke a shell, Git hooks, filters, or repository commands. */
async function trackedFiles(
  root: string,
  cap: number,
  milliseconds: number,
  signal?: AbortSignal
): Promise<{ paths: Set<string>; partial: boolean }> {
  return new Promise((resolveResult) => {
    const paths = new Set<string>();
    let partial = false,
      buffer = '',
      bytes = 0;
    const child = spawnGit('git', gitPathArgs('ls-files', '-z', '--cached', '--'), {
      cwd: root,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
    const end = () => {
      partial = true;
      child.kill();
    };
    const timer = setTimeout(end, milliseconds);
    const abort = () => end();
    signal?.addEventListener('abort', abort, { once: true });
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > 1024 * 1024 || paths.size >= cap) {
        end();
        return;
      }
      buffer += chunk;
      const parts = buffer.split('\0');
      buffer = parts.pop() ?? '';
      for (const path of parts) {
        if (paths.size >= cap) {
          end();
          break;
        }
        paths.add(path);
      }
    });
    let finished = false;
    const finish = (code?: number | null) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      resolveResult({ paths, partial: partial || code !== 0 });
    };
    child.on('error', () => finish(null));
    child.on('close', finish);
  });
}

function factsFor(path: string, content: string): Record<string, string | string[]> {
  const name = basename(path);
  const facts: Record<string, string | string[]> = {};
  if (name === '.gitignore' || name === '.openlore-ignore')
    return {
      patterns: content
        .split(/\r?\n/)
        .filter((x) => x.trim() && !x.trim().startsWith('#'))
        .slice(0, 100),
    };
  if (name.endsWith('.json')) {
    const errors: import('jsonc-parser').ParseError[] = [];
    const data = parseJson(content, errors) as Record<string, unknown> | undefined;
    if (errors.length || !data || typeof data !== 'object' || Array.isArray(data))
      return { parse: 'unsupported-or-invalid' };
    const compiler = data.compilerOptions as Record<string, unknown> | undefined;
    if (typeof compiler?.outDir === 'string' && validPolicyPattern(compiler.outDir))
      facts.output = compiler.outDir;
    if (typeof data.name === 'string') facts.package = data.name.slice(0, 256);
    const workspaces = Array.isArray(data.workspaces)
      ? data.workspaces
      : (data.workspaces as { packages?: unknown } | undefined)?.packages;
    if (Array.isArray(workspaces))
      facts.workspaces = workspaces.filter((x): x is string => validPolicyPattern(x)).slice(0, 100);
    const scripts = data.scripts as Record<string, unknown> | undefined;
    if (scripts && typeof scripts === 'object') {
      const outputs = Object.values(scripts)
        .filter((x): x is string => typeof x === 'string')
        .flatMap((x) =>
          [...x.matchAll(/--(?:outDir|out-dir|output-dir)[= ]+([\w./-]+)/g)].map((m) => m[1])
        )
        .filter(validPolicyPattern);
      if (outputs.length) facts.outputHints = [...new Set(outputs)].slice(0, 20);
    }
  } else if (name === 'Cargo.toml') facts.language = 'Rust';
  else if (path.endsWith('.cargo/config.toml')) {
    const target = /^\s*target-dir\s*=\s*["']([^"']+)["']/m.exec(content)?.[1];
    if (validPolicyPattern(target)) facts.output = target;
  } else if (name === 'pyproject.toml') facts.language = 'Python';
  else if (name === 'go.mod') facts.language = 'Go';
  else if (name === 'pom.xml' || name === 'build.gradle') facts.language = 'Java';
  else facts.format = 'unclassified-declarative-evidence';
  return facts;
}

export async function inspectConfiguration(
  options: ConfigurationOptions = {}
): Promise<ConfigurationInspection> {
  const config = await readConfiguration(options);
  const started = Date.now();
  const budget = { ...CONFIGURATION_SURVEY_BUDGET };
  for (const key of Object.keys(budget) as Array<keyof typeof budget>) {
    const requested = options.budget?.[key];
    if (requested !== undefined)
      budget[key] = Math.min(
        CONFIGURATION_HARD_BUDGET[key],
        Math.max(1, Number.isFinite(requested) ? requested : budget[key])
      );
  }
  const disclosures: ConfigurationDisclosure[] = [];
  if (config.malformed)
    disclosures.push({
      code: 'config-unreadable',
      detail:
        'The selected project config is malformed, oversized, or unreadable; it will not be replaced.',
    });
  if (config.globalUnreadable)
    disclosures.push({
      code: 'user-config-unreadable',
      detail: 'User-wide configuration cannot be assessed.',
    });
  for (const detail of config.policyErrors) disclosures.push({ code: 'invalid-policy', detail });
  const evidence: ConfigurationEvidence[] = [];
  const samples: string[] = [],
    excludedDirectories: string[] = [];
  const topology: string[] = [];
  const counts = { entries: 0, contentBytes: 0, sourceFilesObserved: 0 };
  const tracked = await trackedFiles(
    config.root,
    budget.entries,
    Math.min(250, budget.milliseconds),
    options.signal
  );
  if (tracked.partial)
    disclosures.push({
      code: 'tracked-files-partial',
      detail: 'Git tracking evidence is unavailable or incomplete.',
    });
  options.signal?.throwIfAborted();
  const scope = repositoryPath(options.continuation?.scope ?? options.scope ?? '');
  const requestedScope = safeJoin(config.root, scope);
  if ((await realpath(requestedScope)) !== requestedScope)
    throw new Error('Inspection scope must be a real confined directory');
  if (scope && scope.split('/').some((p) => CONFIGURATION_PRUNED.has(p)))
    throw new Error('Inspection scope is an excluded directory');
  type Scope = { base: string; matcher: ReturnType<typeof ignore> };
  const ignores: Scope[] = [];
  const legacy = ignore().add(
    (config.effective.analysis as { excludePatterns?: string[] } | undefined)?.excludePatterns ?? []
  );
  const ignored = (path: string, directory: boolean, scopes: Scope[]): boolean => {
    const key = repositoryPath(path) + (directory && !path.endsWith('/') ? '/' : '');
    if (!key || key === '/') return false;
    if (legacy.ignores(key) || !config.resolver.admitted(path, 'index', true, directory))
      return true;
    let result = false;
    for (const s of scopes) {
      if (s.base && !key.startsWith(s.base + '/')) continue;
      const match = s.matcher.test(s.base ? key.slice(s.base.length + 1) : key);
      if (match.ignored) result = true;
      // Cross-scope filters remain conservative, as in the structural walker.
    }
    return result;
  };
  let nextScope: string | undefined;
  const limit = (path: string): boolean => {
    options.signal?.throwIfAborted();
    if (
      counts.entries >= budget.entries ||
      counts.contentBytes >= budget.bytes ||
      Date.now() - started >= budget.milliseconds
    ) {
      if (nextScope === undefined) {
        nextScope = path;
        disclosures.push({
          code: 'survey-limit',
          path,
          detail: 'Survey budget reached; evidence is partial. Continue with the disclosed scope.',
        });
      }
      return true;
    }
    return false;
  };
  const contentCache = new Map<string, string | null>();
  const readEvidence = async (path: string, kind: 'ignore' | 'manifest') => {
    if (contentCache.has(path)) return contentCache.get(path) ?? null;
    if (limit(dirname(path))) return null;
    try {
      const content = await readFileConfined(
        config.root,
        path,
        Math.min(budget.fileBytes, budget.bytes - counts.contentBytes),
        true
      );
      counts.contentBytes += Buffer.byteLength(content);
      evidence.push({
        id: kind + ':' + path,
        path,
        kind,
        revision: configurationDigest(content),
        facts: factsFor(path, content),
      });
      contentCache.set(path, content);
      return content;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        disclosures.push({
          code: 'evidence-unreadable',
          path,
          detail: 'Declarative evidence is oversized or cannot be read safely.',
        });
      contentCache.set(path, null);
      return null;
    }
  };
  const loadIgnores = async (path: string, inherited: Scope[]) => {
    const active = [...inherited];
    for (const name of path ? ['.gitignore'] : ['.gitignore', '.openlore-ignore']) {
      const text = await readEvidence(repositoryPath(join(path, name)), 'ignore');
      if (text !== null) active.push({ base: path, matcher: ignore().add(text) });
    }
    return active;
  };
  const walk = async (dir: string, depth: number, inherited: Scope[]) => {
    if (limit(dir)) return;
    if (depth > budget.depth) {
      disclosures.push({
        code: 'depth-limit',
        path: dir,
        detail: 'Directory depth budget reached.',
      });
      return;
    }
    const active = await loadIgnores(dir, inherited);
    let handle: Awaited<ReturnType<typeof opendir>>;
    try {
      const path = safeJoin(config.root, dir);
      if ((await realpath(path)) !== path) throw new Error('Directory changed to a symlink');
      handle = await opendir(path);
      if ((await realpath(path)) !== path) {
        await handle.close();
        throw new Error('Directory changed during inspection');
      }
    } catch {
      disclosures.push({
        code: 'directory-unreadable',
        path: dir,
        detail: 'Directory could not be inspected.',
      });
      return;
    }
    for await (const entry of handle) {
      if (limit(dir)) break;
      counts.entries++;
      const path = repositoryPath(join(dir, entry.name));
      if (entry.isSymbolicLink()) {
        disclosures.push({
          code: 'symlink-skipped',
          path,
          detail: 'Symbolic links are not followed during configuration inspection.',
        });
        continue;
      }
      if (entry.isDirectory()) {
        if (CONFIGURATION_PRUNED.has(entry.name) || ignored(path, true, active)) {
          if (excludedDirectories.length < 100) excludedDirectories.push(path);
          continue;
        }
        topology.push('d:' + path);
        await walk(path, depth + 1, active);
      } else if (entry.isFile()) {
        topology.push('f:' + path);
        if (DECLARATIVE.has(entry.name) && !entry.name.includes('ignore'))
          await readEvidence(path, 'manifest');
        if (CONFIGURATION_SOURCE.test(path) && !ignored(path, false, active)) {
          counts.sourceFilesObserved++;
          if (samples.length < 100) samples.push(path);
          if (tracked.paths.has(path) && evidence.filter((x) => x.kind === 'tracked').length < 20)
            evidence.push({
              id: 'tracked:' + path,
              path,
              kind: 'tracked',
              revision: configurationDigest(path),
              facts: { tracked: 'true' },
            });
        }
      }
    }
  };
  // Root declarations bind continuations even when resuming a nested scope.
  for (const name of [...DECLARATIVE].sort())
    await readEvidence(name, name.includes('ignore') ? 'ignore' : 'manifest');
  const rootRevision = configurationDigest({
    root: config.root,
    config: config.revision,
    evidence: evidence
      .filter((e) => e.kind !== 'tracked' && !e.path.includes('/'))
      .map((e) => [e.path, e.revision])
      .sort(),
  });
  if (options.continuation) {
    const token = options.continuation;
    if (
      !Array.isArray(token.snapshot) ||
      token.snapshot.length > 256 ||
      token.rootRevision !== rootRevision ||
      token.evidenceRevision !==
        configurationDigest({ rootRevision: token.rootRevision, snapshot: token.snapshot })
    )
      throw new Error('Inspection continuation is stale or invalid; inspect again');
    for (const item of token.snapshot) {
      if (!validPolicyPattern(item.path) || !DECLARATIVE.has(basename(item.path)))
        throw new Error('Invalid continuation evidence path');
      const content = await readEvidence(
        item.path,
        basename(item.path).includes('ignore') ? 'ignore' : 'manifest'
      );
      if (content === null || configurationDigest(content) !== item.revision)
        throw new Error('Inspection continuation evidence changed; inspect again');
    }
  }
  if (scope) {
    ignores.push(...(await loadIgnores('', [])));
    let base = '';
    for (const part of scope.split('/').slice(0, -1)) {
      ignores.push(
        ...(await loadIgnores(base, [])).filter((x) => !ignores.some((y) => y.base === x.base))
      );
      base = base ? base + '/' + part : part;
    }
    if (ignored(scope, true, ignores))
      throw new Error('Inspection scope is excluded by current policy');
  }
  await walk(scope, 0, ignores);
  evidence.sort((a, b) => a.path.localeCompare(b.path) || a.kind.localeCompare(b.kind));
  const snapshot = evidence
    .filter((e) => e.kind === 'manifest' || e.kind === 'ignore')
    .map((e) => ({ path: e.path, revision: e.revision }));
  const evidenceRevision = configurationDigest({
    root: config.root,
    config: config.revision,
    evidence: evidence.map((e) => [e.path, e.revision]),
    topology: topology.sort(),
    scope,
    partial: disclosures.map((d) => d.code),
  });
  const runtime: ConfigurationInspection['runtime'] = {
    daemon: 'absent',
    watcher: 'unknown',
    index: 'absent',
    compatibilityScope: 'descriptor-and-protocol',
  };
  if (
    await stat(safeJoin(config.root, join(OPENLORE_ANALYSIS_REL_PATH, 'llm-context.json')))
      .then((x) => x.isFile())
      .catch(() => false)
  )
    runtime.index = 'present-unverified';
  try {
    const descriptor = validateServeDescriptor(
      JSON.parse(
        await readFileConfined(config.root, '.openlore/serve.json', budget.fileBytes, true)
      )
    );
    if (descriptor) {
      runtime.daemon = 'unknown';
      const response = await fetch(serveHttpBaseUrl(descriptor.host, descriptor.port) + '/health', {
        headers: descriptor.token ? { 'x-openlore-token': descriptor.token } : undefined,
        redirect: 'error',
        signal: options.signal
          ? AbortSignal.any([options.signal, AbortSignal.timeout(500)])
          : AbortSignal.timeout(500),
      });
      if (response.ok) {
        const reader = response.body?.getReader();
        let text = '',
          size = 0;
        const decoder = new TextDecoder();
        if (reader) {
          try {
            while (true) {
              const chunk = await reader.read();
              if (chunk.done) break;
              size += chunk.value.length;
              if (size > budget.fileBytes) throw new Error('health too large');
              text += decoder.decode(chunk.value, { stream: true });
            }
          } finally {
            await reader.cancel().catch(() => {});
          }
        }
        const health = validateServeHealth(
          JSON.parse(text + decoder.decode()),
          config.root,
          descriptor
        );
        runtime.daemon = health ? 'compatible' : 'incompatible';
        runtime.watcher = health?.watcher ?? 'unknown';
      }
    }
  } catch {
    /* A descriptor does not prove runtime health or lifecycle authority. */
  }
  const recommendations: ConfigurationRecommendation[] = [];
  for (const item of evidence) {
    const outputs = [
      ...(typeof item.facts.output === 'string' ? [item.facts.output] : []),
      ...(Array.isArray(item.facts.outputHints) ? item.facts.outputHints : []),
    ];
    for (const output of outputs) {
      const path =
        repositoryPath(join(dirname(item.path), output))
          .replace(/^\.\//, '')
          .replace(/\/$/, '') + '/';
      if (!validPolicyPattern(path)) continue;
      const id = 'output-' + configurationDigest(path).slice(0, 12);
      if (recommendations.some((r) => r.id === id)) continue;
      recommendations.push({
        id,
        rule: {
          id,
          pattern: path,
          lanes: { watch: 'exclude', embed: 'exclude' },
          reason: 'Build output declared in ' + item.path,
          evidenceRefs: [item.id],
        },
        evidenceRefs: [item.id],
        basis: typeof item.facts.output === 'string' ? 'declared' : 'hypothesis',
        impact:
          'Avoid build-output watches and embeddings; indexing is unchanged. Actual watch-handle savings have not been measured.',
        uncertainty: [
          'Declared output may contain deliberate exceptions; review its contents and current rules.',
        ],
      });
    }
  }
  options.signal?.throwIfAborted();
  return redactSecrets({
    version: 1,
    root: config.root,
    configPath: config.configPath,
    configRevision: config.revision,
    evidenceRevision,
    policyRevision: config.resolver.revision,
    selection: {
      rules: config.policyErrors.length
        ? []
        : ((config.effective.filePolicies as FilePolicies | undefined)?.rules ?? []),
      includePatterns:
        (config.effective.analysis as { includePatterns?: string[] } | undefined)
          ?.includePatterns ?? [],
      excludePatterns:
        (config.effective.analysis as { excludePatterns?: string[] } | undefined)
          ?.excludePatterns ?? [],
      reviewMode:
        (
          config.effective.configurationAssistant as
            | { reviewMode?: 'manual' | 'notify' }
            | undefined
        )?.reviewMode ?? 'manual',
    },
    evidence,
    samples: samples.sort(),
    excludedDirectories: excludedDirectories.sort(),
    counts,
    complete: disclosures.length === 0,
    disclosures,
    ...(nextScope !== undefined && snapshot.length <= 256
      ? {
          continuation: {
            scope: nextScope,
            rootRevision,
            snapshot,
            evidenceRevision: configurationDigest({ rootRevision, snapshot }),
          },
        }
      : {}),
    runtime,
    recommendations,
  } as ConfigurationInspection);
}
