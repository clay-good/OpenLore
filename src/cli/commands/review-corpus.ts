/**
 * `openlore review-corpus` — deterministic review of governance-corpus intent
 * changes between two revisions or directories (change:
 * add-corpus-change-intent-review).
 */

import { stat } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { Command } from 'commander';
import {
  materializeOpenSpecCorpus,
  prepareOpenSpecCorpusSource,
  resolveBaseRefDisclosed,
  validateGitRef,
  type OpenSpecCorpusMaterialization,
  type OpenSpecCorpusSource,
} from '../../core/drift/git-diff.js';
import {
  reviewCorpusIntent,
  type CorpusIntentFinding,
  type CorpusIntentReviewResult,
} from '../../core/drift/corpus-intent-review.js';
import { readOpenLoreConfigStrict } from '../../core/services/config-manager.js';
import {
  effectivePolicy,
  resolveEnforcementClass,
  type EnforcementPolicy,
} from '../../core/services/mcp-handlers/enforcement-policy.js';
import { sanitizeForTerminal } from '../../utils/misc.js';
import { writeStdout } from '../output.js';

export interface ReviewCorpusCliOptions {
  cwd?: string;
  base?: string;
  head?: string;
  json?: boolean;
}

interface CorpusSourceReceipt {
  kind: 'revision' | 'directory';
  requested: string;
  resolved: string;
}

export interface ReviewCorpusOutput {
  schemaVersion: 1;
  base: CorpusSourceReceipt;
  head: CorpusSourceReceipt;
  verdict: CorpusIntentReviewResult['verdict'];
  reasons: CorpusIntentReviewResult['reasons'];
  findings: Array<CorpusIntentFinding & {
    enforcementClass: ReturnType<typeof resolveEnforcementClass>;
  }>;
}

async function isDirectory(input: string, cwd: string): Promise<string | null> {
  const candidate = resolve(cwd, input);
  try {
    return (await stat(candidate)).isDirectory() ? candidate : null;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    throw error;
  }
}

function hasGitRefSyntax(input: string): boolean {
  try {
    validateGitRef(input);
    return true;
  } catch {
    return false;
  }
}

async function resolveBaseSource(rootPath: string, input: string): Promise<OpenSpecCorpusSource> {
  if (isAbsolute(input) || input.startsWith('./') || input.startsWith('../') || !hasGitRefSyntax(input)) {
    const directory = await isDirectory(input, rootPath);
    if (directory) return { kind: 'directory', directory };
  }
  const resolution = await resolveBaseRefDisclosed(rootPath, input);
  if (!resolution.fellBack) return { kind: 'revision', revision: resolution.resolved };
  if (input !== 'auto') {
    const directory = await isDirectory(input, rootPath);
    if (directory) return { kind: 'directory', directory };
  }
  throw new Error(
    `Base ref "${resolution.requested}" did not resolve; refusing to substitute ` +
    `"${resolution.resolved}".`,
  );
}

async function resolveHeadSource(rootPath: string, input?: string): Promise<OpenSpecCorpusSource> {
  if (input === undefined) return { kind: 'directory', directory: rootPath };
  if (isAbsolute(input) || input.startsWith('./') || input.startsWith('../') || !hasGitRefSyntax(input)) {
    const explicitDirectory = await isDirectory(input, rootPath);
    if (explicitDirectory) return { kind: 'directory', directory: explicitDirectory };
  }
  const resolution = await resolveBaseRefDisclosed(rootPath, input);
  if (!resolution.fellBack) return { kind: 'revision', revision: resolution.resolved };
  const directory = await isDirectory(input, rootPath);
  return directory
    ? { kind: 'directory', directory }
    : { kind: 'revision', revision: input };
}

export async function compareCorpusIntent(options: ReviewCorpusCliOptions = {}): Promise<{
  review: CorpusIntentReviewResult;
  base: OpenSpecCorpusMaterialization['source'];
  head: OpenSpecCorpusMaterialization['source'];
}> {
  const rootPath = resolve(options.cwd ?? process.cwd());
  // Resolve and materialize base first so an invalid explicit base always wins
  // the error path; concurrent failures must not make diagnostics race-dependent.
  const baseSource = await resolveBaseSource(rootPath, options.base ?? 'auto');
  const headSource = await resolveHeadSource(rootPath, options.head);
  const preparedBase = await prepareOpenSpecCorpusSource(rootPath, baseSource);
  const preparedHead = await prepareOpenSpecCorpusSource(rootPath, headSource);
  const base = await materializeOpenSpecCorpus({ rootPath, ...preparedBase });
  const head = await materializeOpenSpecCorpus({ rootPath, ...preparedHead });
  return {
    review: reviewCorpusIntent(base.files, head.files),
    base: { ...base.source, requested: options.base ?? 'auto' },
    head: { ...head.source, requested: options.head ?? rootPath },
  };
}

function renderHuman(output: ReviewCorpusOutput): string {
  const lines = [
    '',
    `Corpus intent review: ${output.verdict}`,
    `Base: ${output.base.kind} ${output.base.requested} → ${output.base.resolved}`,
    `Head: ${output.head.kind} ${output.head.requested} → ${output.head.resolved}`,
  ];
  if (output.findings.length === 0) {
    lines.push('No corpus intent findings.');
  } else {
    for (const finding of output.findings) {
      lines.push(
        `[${finding.enforcementClass}] ${finding.code} ${finding.artifact}: ${finding.message}`,
      );
    }
  }
  lines.push('');
  return lines.map((line) => sanitizeForTerminal(line)).join('\n');
}

export async function runReviewCorpusCli(options: ReviewCorpusCliOptions = {}): Promise<number> {
  const rootPath = resolve(options.cwd ?? process.cwd());
  try {
    const config = await readOpenLoreConfigStrict(rootPath);
    const { review, base, head } = await compareCorpusIntent({ ...options, cwd: rootPath });
    const policy: EnforcementPolicy = effectivePolicy(config);
    const findings = review.findings.map((finding) => ({
      ...finding,
      enforcementClass: resolveEnforcementClass(finding.code, policy, 'warning'),
    }));
    const output: ReviewCorpusOutput = {
      schemaVersion: 1,
      base,
      head,
      verdict: review.verdict,
      reasons: review.reasons,
      findings,
    };
    await writeStdout(options.json
      ? JSON.stringify(output, null, 2) + '\n'
      : renderHuman(output));
    return findings.some((finding) => finding.enforcementClass === 'blocking') ? 1 : 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      sanitizeForTerminal(`review-corpus: ${message}\n`, { keepNewlines: true }),
    );
    return 2;
  }
}

export const reviewCorpusCommand = new Command('review-corpus')
  .description('Review governance-corpus intent changes between two revisions or directories.')
  .option('--base <ref-or-directory>', 'Base Git revision or directory (default: auto-detected main)', 'auto')
  .option('--head <ref-or-directory>', 'Head Git revision or directory (default: working tree)')
  .option('--json', 'Emit deterministic machine-readable JSON', false)
  .action(async (options: { base: string; head?: string; json?: boolean }) => {
    process.exitCode = await runReviewCorpusCli(options);
  });
