/**
 * `openlore check-edit` reads the latest watcher-produced per-edit verdict.
 * Hook mode is deliberately read-only: it may wait briefly for the watcher's
 * debounced atomic write, but it never parses code or invokes a fallback analysis.
 */

import { Command } from 'commander';
import { constants, realpathSync, accessSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { writeStdout } from '../output.js';
import { readStdin } from '../../utils/stdin.js';
import { sanitizeForTerminal } from '../../utils/misc.js';
import { readOpenLoreConfig } from '../../core/services/config-manager.js';
import { normalizeEnforcementPolicy } from '../../core/services/mcp-handlers/enforcement-policy.js';
import {
  readCurrentEditVerdicts,
  type EditVerdict,
  type EditVerdictRead,
  type EditVerdictStoreBoundary,
} from '../../core/services/edit-verdict.js';

const HOOK_POLL_MS = 1_200;
const HOOK_POLL_INTERVAL_MS = 50;
const HOOK_STDIN_MAX_BYTES = 64 * 1024;

export interface CheckEditCliOptions {
  cwd?: string;
  file?: string;
  json?: boolean;
  hook?: boolean;
  /** Test seam; command callers use the bounded defaults above. */
  hookPollMs?: number;
  /** Test seam; command callers use the bounded defaults above. */
  hookPollIntervalMs?: number;
}

function delay(ms: number): Promise<void> {
  // This timer intentionally remains referenced. The hook has detached stdin by
  // this point, so unref'ing the only remaining handle would let Node exit before
  // the watcher publishes the matching content-hash verdict.
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

/** Resolve a hook/user path to a safe repository-relative path. */
export function repoRelativeFile(rootPath: string, value: unknown): string | undefined {
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  let root: string;
  let absolute: string;
  try {
    root = realpathSync(resolve(rootPath));
    const requested = isAbsolute(value) ? resolve(value) : resolve(root, value);
    absolute = realpathSync(requested);
    accessSync(absolute, constants.R_OK);
    if (!statSync(absolute).isFile()) return undefined;
  } catch {
    return undefined;
  }
  const rel = relative(root, absolute);
  if (rel === '' || rel === '..' || rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(rel)) return undefined;
  return rel.replaceAll('\\', '/');
}

/** Extract the edited file from a Claude-style PostToolUse stdin payload. */
export function fileFromHookPayload(rootPath: string, raw: string): string | undefined {
  try {
    const parsed = JSON.parse(raw) as { tool_input?: Record<string, unknown> };
    const input = parsed?.tool_input;
    if (!input || typeof input !== 'object') return undefined;
    return repoRelativeFile(rootPath, input.file_path ?? input.path ?? input.notebook_path);
  } catch {
    return undefined;
  }
}

async function readWithBoundedPoll(
  rootPath: string,
  files: readonly string[] | undefined,
  maxWaitMs: number,
  intervalMs: number,
): Promise<EditVerdictRead> {
  const started = Date.now();
  let result = await readCurrentEditVerdicts(rootPath, files);
  while (result.status !== 'current' && Date.now() - started < maxWaitMs) {
    await delay(Math.min(intervalMs, Math.max(0, maxWaitMs - (Date.now() - started))));
    result = await readCurrentEditVerdicts(rootPath, files);
  }
  return result;
}

function renderCurrent(entries: readonly EditVerdict[], storeBoundaries?: EditVerdictStoreBoundary): string {
  const lines = ['', '🔎 Edit verdict'];
  if (storeBoundaries) {
    lines.push(
      `   ⚠ Verdict store evicted ${storeBoundaries.entriesEvicted} older entr${storeBoundaries.entriesEvicted === 1 ? 'y' : 'ies'}${storeBoundaries.evictedFiles.length > 0 ? ` (${storeBoundaries.evictedFiles.join(', ')})` : ''}.`,
    );
    if (storeBoundaries.bytesBounded) {
      lines.push('   ⚠ Verdict store reached its byte bound; older edited-file verdicts may be unavailable.');
    }
  }
  if (entries.length === 0) lines.push('   No current edited-file verdicts.');
  for (const entry of entries) {
    lines.push(`   ${entry.file}: ${entry.findings.length} structural breakage finding(s)`);
    for (const finding of entry.findings) {
      const location = finding.location
        ? `${finding.location.path}${finding.location.line === undefined ? '' : `:${finding.location.line}`}: `
        : '';
      lines.push(`   ⚠ [${finding.code}] ${location}${finding.message}`);
    }
    if (entry.reachingTests.length > 0) {
      lines.push(`   Tests to run (${entry.reachingTests.length}): ${entry.reachingTests.slice(0, 8).map((test) => test.file).join(', ')}${entry.reachingTests.length > 8 ? ', …' : ''}`);
    }
    if (entry.boundaries.reachingTestsTruncated) lines.push('   ⚠ Reaching-test selection was truncated.');
    if (entry.boundaries.staleFiles.length > 0) lines.push(`   ⚠ ${entry.boundaries.staleFiles.length} caller file(s) remain stale; findings are a lower bound.`);
  }
  lines.push('');
  return sanitizeForTerminal(lines.join('\n'), { keepNewlines: true });
}

function renderUnavailable(result: Exclude<EditVerdictRead, { status: 'current' }>): string {
  return sanitizeForTerminal(`\n⚠ check-edit ${result.status}: ${result.reason}\n`, { keepNewlines: true });
}

export async function runCheckEditCli(opts: CheckEditCliOptions): Promise<number> {
  const cwd = resolve(opts.cwd ?? process.cwd());
  let requestedFile = repoRelativeFile(cwd, opts.file);
  if (opts.file && !requestedFile) {
    const message = 'check-edit: --file must resolve to a file inside the repository.';
    if (opts.hook) { process.stderr.write(message + '\n'); return 0; }
    if (opts.json) await writeStdout(JSON.stringify({ kind: 'edit-verdict', version: 1, status: 'invalid', reason: message }, null, 2) + '\n');
    else await writeStdout(message + '\n');
    return 1;
  }

  try {
    if (opts.hook && !requestedFile) {
      requestedFile = fileFromHookPayload(cwd, await readStdin(process.stdin, 1500, HOOK_STDIN_MAX_BYTES));
      if (!requestedFile) {
        process.stderr.write(
          'check-edit hook: stdin payload is malformed, has no edited file, or names a file outside the repository; skipping verdict.\n',
        );
        return 0;
      }
    }
    const files = requestedFile ? [requestedFile] : undefined;
    const result = opts.hook
      ? await readWithBoundedPoll(
          cwd,
          files,
          Math.max(0, opts.hookPollMs ?? HOOK_POLL_MS),
          Math.max(1, opts.hookPollIntervalMs ?? HOOK_POLL_INTERVAL_MS),
        )
      : await readCurrentEditVerdicts(cwd, files);

    if (opts.hook) {
      process.stderr.write(result.status === 'current' ? renderCurrent(result.entries, result.storeBoundaries) : renderUnavailable(result));
      if (result.status !== 'current') return 0;

      // Only an explicit `enforcement.policy` entry may block an agent turn.
      // Source defaults and frozen debt remain advisory in this low-latency path.
      let policy: ReturnType<typeof normalizeEnforcementPolicy> = {};
      try {
        const config = await readOpenLoreConfig(cwd);
        policy = normalizeEnforcementPolicy(config?.enforcement);
      } catch {
        return 0;
      }
      const blocking = result.entries.flatMap((entry) => entry.findings)
        .filter((finding) => policy[finding.code] === 'blocking');
      if (blocking.length > 0) {
        process.stderr.write('\n⛔ check-edit: edit blocked by explicit enforcement.policy. Repair the findings above and retry.\n\n');
        return 2;
      }
      return 0;
    }

    if (opts.json) {
      await writeStdout(JSON.stringify({ kind: 'edit-verdict', version: 1, ...result }, null, 2) + '\n');
    } else {
      await writeStdout(result.status === 'current' ? renderCurrent(result.entries, result.storeBoundaries) : renderUnavailable(result));
    }
    return 0;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    if (opts.hook) {
      process.stderr.write(renderUnavailable({ status: 'invalid', entries: [], reason }));
      return 0;
    }
    if (opts.json) await writeStdout(JSON.stringify({ kind: 'edit-verdict', version: 1, status: 'invalid', reason }, null, 2) + '\n');
    else await writeStdout(renderUnavailable({ status: 'invalid', entries: [], reason }));
    return 0;
  }
}

export const checkEditCommand = new Command('check-edit')
  .description('Read the latest watcher-produced structural breakage verdict for an edited file or working set.')
  .option('--file <path>', 'Read the verdict for one repository file (hook mode also accepts the PostToolUse payload on stdin)')
  .option('--json', 'Emit the verdict as JSON', false)
  .option('--hook', 'PostToolUse mode: read only, write to stderr, and exit 2 only for explicitly blocking findings', false)
  .action(async (options: { file?: string; json?: boolean; hook?: boolean }) => {
    process.exit(await runCheckEditCli(options));
  });
