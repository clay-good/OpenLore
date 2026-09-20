/**
 * Passive update notifier (change: add-zero-interaction-onboarding).
 *
 * Best-practice, npm/gh/brew-style: a cached, non-blocking, fail-silent check
 * against the npm registry that tells a human "a newer openlore is available"
 * on stderr — never blocks a command, never prints in CI or non-interactive
 * contexts, and is silenceable. The actual upgrade is a separate explicit step
 * (`openlore update`); this module only *notifies*.
 *
 * Design rules (so it can never harm the hot path):
 * - Reads a cached result and prints synchronously (instant); a stale cache is
 *   refreshed in the background and is NOT awaited, so no command ever waits on
 *   the network for the notifier.
 * - Suppressed unless stderr is a TTY (keeps agent/MCP/hook output clean), and
 *   in CI, and when OPENLORE_NO_UPDATE_NOTIFIER / NO_UPDATE_NOTIFIER is set.
 * - Every network and disk operation is wrapped to never throw.
 * - 100% deterministic given an injected lookup/clock — no LLM, no new runtime
 *   dependency (uses npm itself so all `.npmrc` transport settings apply).
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { OPENLORE_DIR } from '../../constants.js';
import {
  resolvePlatformCommand,
  type PlatformCommand,
  type PlatformCommandRuntime,
} from '../../utils/platform-command.js';

/** Published package name on npm. */
export const PACKAGE_NAME = 'openlore';
/** Direct fallback used only when the npm executable is absent. */
export const REGISTRY_LATEST_URL = `https://registry.npmjs.org/${PACKAGE_NAME}/latest`;
/** How long a cached check stays fresh before a background refresh. */
export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24h
/** Network budget for the background refresh. */
export const FETCH_TIMEOUT_MS = 2000;

/** Default cache file: ~/.openlore/update-check.json (per the repo cache convention). */
export function defaultCacheFile(): string {
  return join(homedir(), OPENLORE_DIR, 'update-check.json');
}

export interface UpdateCache {
  /** Latest version seen at the last successful check. */
  latest: string;
  /** Epoch ms of the last check attempt. */
  checkedAt: number;
}

export interface NotifyOptions {
  /** Override the cache file (tests). */
  cacheFile?: string;
  /** Override the environment (tests). Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  /** Where the banner is written. Defaults to process.stderr. */
  stream?: { write(s: string): void; isTTY?: boolean };
  /** Clock injection (tests). Defaults to Date.now. */
  now?: () => number;
  /** Network fetcher injection (tests). Defaults to global fetch. */
  fetcher?: (url: string, init?: { signal?: AbortSignal }) => Promise<{ ok: boolean; json(): Promise<unknown> }>;
  /** Package-manager lookup injection (tests). Defaults to `npm view`. */
  lookup?: VersionLookup;
  /**
   * npm-resolution injection (tests). The "npm is absent" case cannot be produced by emptying
   * `PATH` on Windows, where npm is found beside the running Node executable, so a test states
   * absence here instead of arranging it through the environment.
   */
  npmRuntime?: PlatformCommandRuntime;
  /** True when the lookup must not keep the process alive. */
  background?: boolean;
  /** Force the TTY decision (tests). */
  isTTY?: boolean;
}

export interface VersionLookupOptions {
  signal: AbortSignal;
  background: boolean;
}

export type VersionLookup = (options: VersionLookupOptions) => Promise<unknown>;

/** Keep an unref'ed lookup from surviving the process that requested it. */
export function terminateChildOnParentExit(
  child: { killed: boolean; kill(): boolean },
): () => void {
  const terminate = (): void => {
    if (!child.killed) child.kill();
  };
  process.once('exit', terminate);
  return () => process.removeListener('exit', terminate);
}

/**
 * Where the npm lookup runs. NEVER the analyzed repository: npm reads the `.npmrc` of its working
 * directory, and that file is repo-controlled — it could point the lookup at an arbitrary registry
 * and answer with a version of its choosing (mcp-security: repo-controlled configuration is
 * untrusted). The notifier speaks about the GLOBALLY installed `openlore`, so the user scope is
 * also the correct one: `~/.npmrc` still supplies a private registry, its credentials, the CA and
 * the proxy.
 */
export function npmViewCwd(): string {
  return homedir();
}

/** Build the npm lookup as fixed argv so npm remains the owner of `.npmrc`. */
export function npmViewInvocation(
  platform: NodeJS.Platform = process.platform,
  runtime: PlatformCommandRuntime = {},
): PlatformCommand {
  const args = ['view', `${PACKAGE_NAME}@latest`, 'version', '--json'];
  const npmExecPath = runtime.npmExecPath ?? process.env.npm_execpath;
  if (npmExecPath?.trim()) {
    return {
      command: runtime.nodeExecutable ?? process.execPath,
      args: [npmExecPath, ...args],
    };
  }
  return resolvePlatformCommand('npm', args, platform, runtime);
}

/** Parse "1.2.3" (ignoring any prerelease/build suffix) into [maj,min,patch]. */
function parseVersion(v: string): [number, number, number] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(v.trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/**
 * True when `latest` is strictly newer than `current` by semver core
 * (major.minor.patch). Prerelease tags are ignored — a stable release is the
 * only thing we nudge a user toward. Returns false on any unparseable input.
 */
export function isNewer(current: string, latest: string): boolean {
  const a = parseVersion(current);
  const b = parseVersion(latest);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (b[i] > a[i]) return true;
    if (b[i] < a[i]) return false;
  }
  return false;
}

function readCache(file: string): UpdateCache | null {
  try {
    const raw = readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw) as Partial<UpdateCache>;
    if (typeof parsed.latest === 'string' && typeof parsed.checkedAt === 'number') {
      return { latest: parsed.latest, checkedAt: parsed.checkedAt };
    }
  } catch {
    /* missing or corrupt cache → treat as no cache */
  }
  return null;
}

function writeCache(file: string, cache: UpdateCache): void {
  try {
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, JSON.stringify(cache), 'utf8');
  } catch {
    /* a non-writable home must never break a command */
  }
}

function npmViewLatestVersion(runtime: PlatformCommandRuntime = {}): VersionLookup {
  return async (options) => {
  let invocation: PlatformCommand;
  try {
    invocation = npmViewInvocation(process.platform, runtime);
  } catch (error) {
    if (error instanceof Error && error.message.includes('Could not locate npm-cli.js')) {
      (error as NodeJS.ErrnoException).code = 'ENOENT';
    }
    throw error;
  }

  return await new Promise<unknown>((resolve, reject) => {
    let removeExitListener = (): void => undefined;
    const child = execFile(
      invocation.command,
      invocation.args,
      {
        cwd: npmViewCwd(),
        encoding: 'utf8',
        maxBuffer: 256 * 1024,
        shell: false,
        signal: options.signal,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        removeExitListener();
        if (error) {
          const detail = stderr.trim();
          reject(detail ? new Error(detail) : error);
          return;
        }
        try {
          resolve(JSON.parse(stdout.trim()) as unknown);
        } catch {
          reject(new Error('npm answered without a JSON version'));
        }
      },
    );
    if (options.background) {
      removeExitListener = terminateChildOnParentExit(child);
      child.unref();
      (child.stdout as { unref?: () => void } | null)?.unref?.();
      (child.stderr as { unref?: () => void } | null)?.unref?.();
    }
  });
  };
}

function directRegistryLatestVersion(
  fetcher: NonNullable<NotifyOptions['fetcher']>,
): VersionLookup {
  return async (options) => {
    const response = await fetcher(REGISTRY_LATEST_URL, { signal: options.signal });
    if (!response.ok) return null;
    return await response.json();
  };
}

function defaultLatestVersionLookup(
  fetcher: NonNullable<NotifyOptions['fetcher']>,
  runtime: PlatformCommandRuntime = {},
): VersionLookup {
  return async (options) => {
    try {
      return await npmViewLatestVersion(runtime)(options);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return await directRegistryLatestVersion(fetcher)(options);
    }
  };
}

/**
 * Read the version out of an answer, whatever shape it came in.
 *
 * `npm view <pkg>@latest version --json` answers with a bare string on some npm releases and with
 * an ARRAY of the matched versions on others (npm 10/11 here: `["3.2.0"]`) — an array the first
 * version of this lookup dropped, so the check silently reported "no update" forever. The registry
 * endpoint answers with the `{ version }` document. All three are accepted; the array keeps its
 * last entry, which is the highest version npm matched.
 */
export function readAnswerVersion(answer: unknown): string | null {
  if (typeof answer === 'string') return answer.trim() || null;
  if (Array.isArray(answer)) {
    const last = [...answer].reverse().find((entry) => typeof entry === 'string' && entry.trim());
    return typeof last === 'string' ? last.trim() : null;
  }
  const body = answer as { version?: unknown } | null;
  if (!body || typeof body !== 'object') return null;
  return typeof body.version === 'string' ? body.version : null;
}

/** Fetch the latest published version, or null on any failure (never throws). */
export async function fetchLatestVersion(opts: NotifyOptions = {}): Promise<string | null> {
  const fetcher = opts.fetcher ?? (globalThis.fetch as NotifyOptions['fetcher']);
  if (!fetcher) return null;
  const lookup = opts.lookup
    ?? (opts.fetcher
      ? directRegistryLatestVersion(fetcher)
      : defaultLatestVersionLookup(fetcher, opts.npmRuntime ?? {}));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  if (typeof timer === 'object' && 'unref' in timer) timer.unref();
  try {
    const answer = await lookup({
      signal: controller.signal,
      background: opts.background ?? false,
    });
    return readAnswerVersion(answer);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Refresh the cache from the network. Fail-silent; safe to fire-and-forget. */
export async function refreshCache(opts: NotifyOptions = {}): Promise<void> {
  const file = opts.cacheFile ?? defaultCacheFile();
  const now = opts.now ?? Date.now;
  const latest = await fetchLatestVersion({ ...opts, background: true });
  if (latest) writeCache(file, { latest, checkedAt: now() });
}

/** The boxed banner shown to a human on stderr. */
export function formatBanner(current: string, latest: string): string {
  const line1 = `Update available: ${current} → ${latest}`;
  const line2 = `Run: openlore update`;
  const width = Math.max(line1.length, line2.length);
  const top = '┌' + '─'.repeat(width + 2) + '┐';
  const bot = '└' + '─'.repeat(width + 2) + '┘';
  const pad = (s: string): string => `│ ${s.padEnd(width)} │`;
  return `\n${top}\n${pad(line1)}\n${pad(line2)}\n${bot}\n`;
}

/**
 * Print an update banner if a newer version is cached, then refresh a stale
 * cache in the background (NOT awaited). Returns true if a banner was printed.
 *
 * Suppressed entirely (returns false, no network) when: a silencing env var is
 * set, CI is detected, or stderr is not a TTY — so agents, MCP servers, hooks,
 * and pipelines never see it.
 */
export function notifyIfUpdateAvailable(current: string, opts: NotifyOptions = {}): boolean {
  const env = opts.env ?? process.env;
  if (env.OPENLORE_NO_UPDATE_NOTIFIER || env.NO_UPDATE_NOTIFIER) return false;
  if (env.CI) return false;
  const stream = opts.stream ?? process.stderr;
  const isTTY = opts.isTTY ?? Boolean((stream as { isTTY?: boolean }).isTTY);
  if (!isTTY) return false;

  const file = opts.cacheFile ?? defaultCacheFile();
  const now = opts.now ?? Date.now;
  const cache = readCache(file);

  let printed = false;
  if (cache && isNewer(current, cache.latest)) {
    stream.write(formatBanner(current, cache.latest));
    printed = true;
  }

  // Refresh a missing/stale cache in the background. Deliberately not awaited:
  // the notifier must never add latency. A short-lived CLI may exit before this
  // resolves — that's fine, the next eligible run picks up the refreshed cache.
  if (!cache || now() - cache.checkedAt > CHECK_INTERVAL_MS) {
    void refreshCache(opts);
  }
  return printed;
}
