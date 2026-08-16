/**
 * `openlore change-status` computes the evidence pass documented in
 * `openspec/changes/STATUS.md` (change: add-change-evidence-audit).
 *
 * This command deliberately does not decide whether an implementation is correct
 * and never mutates the OpenSpec lifecycle. Validation and archiving remain owned
 * by the `openspec` CLI.
 */

import { execFile } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { promisify } from 'node:util';
import { Command } from 'commander';
import { glob } from 'glob';
import { parse as parseYaml } from 'yaml';
import { safeJoin } from '../../utils/path-confinement.js';
import { writeStdout } from '../output.js';

const execFileAsync = promisify(execFile);
const CHANGE_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

export const EVIDENCE_DISCLAIMER =
  'Verdicts reflect documented evidence signals, not runtime correctness.';
export const BUILT_UNMARKED_CAVEAT = 'verify against code before trusting';

export type ChangeVerdict =
  | 'built'
  | 'built-unmarked'
  | 'partially-built'
  | 'unbuilt'
  | 'not-assessed';

export interface MarkerReceipt {
  file: string;
  line: number;
}

export interface RequirementReceipt {
  domain: string;
  name: string;
  deltaFile: string;
  present: boolean;
}

export interface ValidationReceipt {
  passes: boolean;
  error?: string;
}

export interface TaskProgress {
  checked: number;
  total: number;
}

export interface ChangeStatusResult {
  name: string;
  verdict: ChangeVerdict;
  marker: { present: boolean; receipts: MarkerReceipt[] };
  requirementsSynced: {
    all: boolean;
    synced: number;
    total: number;
    requirements: RequirementReceipt[];
  };
  validates: ValidationReceipt;
  tasks: TaskProgress;
  archivableCandidate: boolean;
  caveat?: string;
  assessmentError?: string;
  evidenceDisclaimer: string;
}

export type ValidateChange = (rootPath: string, name: string) => Promise<ValidationReceipt>;

interface AuditOptions {
  rootPath: string;
  name?: string;
  validateChange?: ValidateChange;
}

/** Invoke OpenSpec's validator. OpenLore intentionally does not reproduce it. */
export async function validateWithOpenSpec(rootPath: string, name: string): Promise<ValidationReceipt> {
  try {
    await execFileAsync('openspec', ['validate', name, '--type', 'change', '--no-interactive'], {
      cwd: rootPath,
      maxBuffer: 8 * 1024 * 1024,
    });
    return { passes: true };
  } catch (error) {
    const e = error as Error & { stderr?: string | Buffer; stdout?: string | Buffer };
    const detail = String(e.stderr || e.stdout || e.message).trim();
    return { passes: false, error: detail || 'openspec validate failed' };
  }
}

async function listOpenChanges(rootPath: string): Promise<string[]> {
  const changesRoot = safeJoin(rootPath, 'openspec/changes');
  const entries = await readdir(changesRoot, { withFileTypes: true });
  const names = entries
    .filter((entry) => entry.isDirectory() && entry.name !== 'archive')
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
  if (names.some((name) => !CHANGE_NAME_PATTERN.test(name))) {
    throw new Error('Invalid open change directory name; expected lowercase letters, digits, and hyphens');
  }
  return names;
}

/** Scan source once and index every conventional `change: <name>` receipt. */
async function scanMarkers(rootPath: string): Promise<Map<string, MarkerReceipt[]>> {
  const sourceRoot = safeJoin(rootPath, 'src');
  const paths = await glob('**/*', { cwd: sourceRoot, nodir: true, dot: true, follow: false });
  const markers = new Map<string, MarkerReceipt[]>();

  for (const path of paths.sort((a, b) => a.localeCompare(b))) {
    let content: string;
    try {
      content = await readFile(safeJoin(rootPath, `src/${path}`), 'utf8');
    } catch {
      continue;
    }
    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const pattern = /\bchange:\s*([a-z0-9][a-z0-9-]*)\b/g;
      for (const match of lines[i].matchAll(pattern)) {
        const receipts = markers.get(match[1]) ?? [];
        receipts.push({ file: `src/${path.replaceAll('\\', '/')}`, line: i + 1 });
        markers.set(match[1], receipts);
      }
    }
  }
  return markers;
}

/** Lines OpenSpec's Markdown parser can treat as structure, excluding fenced examples. */
function structuralMarkdownLines(content: string): string[] {
  const lines: string[] = [];
  let fence: { char: '`' | '~'; length: number } | undefined;
  const normalized = content.replace(/^\uFEFF/, '');
  for (const line of normalized.split(/\r\n|\n|\r/)) {
    const marker = line.match(/^\s*(`{3,}|~{3,})(.*)$/);
    if (marker) {
      const char = marker[1][0] as '`' | '~';
      if (!fence) fence = { char, length: marker[1].length };
      else if (
        fence.char === char
        && marker[1].length >= fence.length
        && marker[2].trim() === ''
      ) fence = undefined;
      continue;
    }
    if (!fence) lines.push(line);
  }
  return lines;
}

function relevantRequirementNames(content: string, deltaFile: string): string[] {
  const lines = structuralMarkdownLines(content);
  const names: string[] = [];
  let relevantSection = false;
  let relevantSectionSeen = false;
  let deltaSectionSeen = false;
  let requirementsInSection = 0;

  const finishSection = (): void => {
    if (relevantSection && requirementsInSection === 0) {
      throw new Error(`${deltaFile}: ADDED/MODIFIED Requirements section has no valid requirement headings`);
    }
  };

  for (const line of lines) {
    const section = line.match(/^##\s+(ADDED|MODIFIED|REMOVED|RENAMED)\s+Requirements\s*$/i);
    if (section) {
      finishSection();
      deltaSectionSeen = true;
      relevantSection = ['ADDED', 'MODIFIED'].includes(section[1].toUpperCase());
      relevantSectionSeen ||= relevantSection;
      requirementsInSection = 0;
      continue;
    }
    if (/^##\s+/.test(line)) {
      finishSection();
      relevantSection = false;
      requirementsInSection = 0;
      continue;
    }
    if (!relevantSection) continue;
    const requirement = line.match(/^###\s*Requirement:\s*(.*)$/i);
    if (requirement) {
      const name = requirement[1].trim();
      if (!name) throw new Error(`${deltaFile}: requirement heading has no name`);
      names.push(name);
      requirementsInSection++;
    }
  }
  finishSection();

  if (!deltaSectionSeen) {
    throw new Error(`${deltaFile}: no ADDED/MODIFIED/REMOVED/RENAMED Requirements section found`);
  }
  // A delta containing no relevant section can be valid for this audit (for example,
  // REMOVED-only). OpenSpec remains the authority on whether the file itself validates.
  return relevantSectionSeen ? names : [];
}

function mainRequirementNames(content: string, targetFile: string): Set<string> {
  const names = new Set<string>();
  let inRequirements = false;
  let sectionSeen = false;
  for (const line of structuralMarkdownLines(content)) {
    if (/^##\s+Requirements\s*$/i.test(line)) {
      inRequirements = true;
      sectionSeen = true;
      continue;
    }
    if (/^##\s+/.test(line)) {
      inRequirements = false;
      continue;
    }
    if (!inRequirements) continue;
    const requirement = line.match(/^###\s*Requirement:\s*(\S.*)$/i);
    if (requirement) names.add(requirement[1].trim());
  }
  if (!sectionSeen) throw new Error(`${targetFile}: no Requirements section found`);
  return names;
}

async function requirementReceipts(
  rootPath: string,
  name: string,
  validationPasses: boolean,
): Promise<RequirementReceipt[]> {
  const specsRoot = safeJoin(rootPath, `openspec/changes/${name}/specs`);
  const deltaPaths = await glob('**/spec.md', { cwd: specsRoot, nodir: true, follow: false });
  if (deltaPaths.length === 0) {
    const metadataPath = safeJoin(rootPath, `openspec/changes/${name}/.openspec.yaml`);
    try {
      const metadata = parseYaml(await readFile(metadataPath, 'utf8')) as unknown;
      if (
        validationPasses
        &&
        metadata
        && typeof metadata === 'object'
        && (metadata as Record<string, unknown>).skip_specs === true
      ) return [];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    throw new Error(`openspec/changes/${name}/specs: no delta spec files found`);
  }
  const mainRequirements = new Map<string, Set<string>>();
  const receipts: RequirementReceipt[] = [];
  const seenRequirements = new Set<string>();

  for (const deltaPath of deltaPaths.sort((a, b) => a.localeCompare(b))) {
    const domain = deltaPath.replaceAll('\\', '/').replace(/\/spec\.md$/, '');
    const deltaFile = relative(rootPath, join(specsRoot, deltaPath)).split(sep).join('/');
    const deltaAbsolutePath = safeJoin(rootPath, deltaFile);
    const names = relevantRequirementNames(await readFile(deltaAbsolutePath, 'utf8'), deltaFile);
    if (names.length === 0) continue;
    let targetNames = mainRequirements.get(domain);
    if (!targetNames) {
      const targetPath = safeJoin(rootPath, `openspec/specs/${domain}/spec.md`);
      try {
        const target = await readFile(targetPath, 'utf8');
        const targetFile = relative(rootPath, targetPath).split(sep).join('/');
        targetNames = mainRequirementNames(target, targetFile);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        // A new domain has no baseline spec yet. Its added requirements are absent,
        // not unparseable; OpenSpec validation remains the schema authority.
        targetNames = new Set<string>();
      }
      mainRequirements.set(domain, targetNames);
    }
    for (const requirementName of names) {
      const key = `${domain}\0${requirementName}`;
      if (seenRequirements.has(key)) continue;
      seenRequirements.add(key);
      receipts.push({
        domain,
        name: requirementName,
        deltaFile,
        present: targetNames.has(requirementName),
      });
    }
  }
  return receipts;
}

async function taskProgress(rootPath: string, name: string): Promise<TaskProgress> {
  try {
    const path = safeJoin(rootPath, `openspec/changes/${name}/tasks.md`);
    const content = await readFile(path, 'utf8');
    const boxes = [...content.matchAll(/^\s*-\s*\[([ xX])\]/gm)];
    return {
      checked: boxes.filter((match) => match[1].toLowerCase() === 'x').length,
      total: boxes.length,
    };
  } catch {
    return { checked: 0, total: 0 };
  }
}

function verdictFor(marker: boolean, requirements: RequirementReceipt[], parseFailed: boolean): ChangeVerdict {
  if (parseFailed) return 'not-assessed';
  const synced = requirements.filter((requirement) => requirement.present).length;
  const allSynced = synced === requirements.length;
  if (marker && allSynced) return 'built';
  if (!marker && requirements.length > 0 && allSynced) return 'built-unmarked';
  if (marker || synced > 0) return 'partially-built';
  return 'unbuilt';
}

export async function auditChangeStatuses(options: AuditOptions): Promise<ChangeStatusResult[]> {
  if (options.name && !CHANGE_NAME_PATTERN.test(options.name)) {
    throw new Error('Invalid change name; expected lowercase letters, digits, and hyphens');
  }
  const names = await listOpenChanges(options.rootPath);
  if (options.name && !names.includes(options.name)) {
    throw new Error(`Open change not found: ${options.name}`);
  }
  const selected = options.name ? [options.name] : names;
  const markers = await scanMarkers(options.rootPath);
  const validateChange = options.validateChange ?? validateWithOpenSpec;
  const results: ChangeStatusResult[] = [];

  for (const name of selected) {
    const validates = await validateChange(options.rootPath, name);
    let requirements: RequirementReceipt[] = [];
    let assessmentError: string | undefined;
    try {
      requirements = await requirementReceipts(options.rootPath, name, validates.passes);
    } catch (error) {
      assessmentError = error instanceof Error ? error.message : String(error);
    }
    const markerReceipts = markers.get(name) ?? [];
    const verdict = verdictFor(markerReceipts.length > 0, requirements, Boolean(assessmentError));
    const synced = requirements.filter((requirement) => requirement.present).length;
    results.push({
      name,
      verdict,
      marker: { present: markerReceipts.length > 0, receipts: markerReceipts },
      requirementsSynced: {
        all: !assessmentError && synced === requirements.length,
        synced,
        total: requirements.length,
        requirements,
      },
      validates,
      tasks: await taskProgress(options.rootPath, name),
      archivableCandidate: verdict === 'built' && validates.passes,
      ...(verdict === 'built-unmarked' ? { caveat: BUILT_UNMARKED_CAVEAT } : {}),
      ...(assessmentError ? { assessmentError } : {}),
      evidenceDisclaimer: EVIDENCE_DISCLAIMER,
    });
  }
  return results;
}

function renderHuman(results: ChangeStatusResult[]): string {
  const lines = [`Change evidence audit`, EVIDENCE_DISCLAIMER, ''];
  for (const result of results) {
    lines.push(`${result.name}: ${result.verdict}${result.archivableCandidate ? ' (archivable-candidate)' : ''}`);
    lines.push(`  marker: ${result.marker.present ? 'present' : 'absent'}`);
    for (const receipt of result.marker.receipts) lines.push(`    ${inlineText(receipt.file)}:${receipt.line}`);
    lines.push(
      `  requirements synced: ${result.requirementsSynced.synced}/${result.requirementsSynced.total}`,
      `  validates: ${result.validates.passes ? 'yes' : 'no'}`,
      `  tasks: ${result.tasks.checked}/${result.tasks.total} (display only)`,
    );
    if (result.caveat) lines.push(`  caveat: ${result.caveat}`);
    if (result.assessmentError) lines.push(`  assessment error: ${inlineText(result.assessmentError)}`);
    if (result.validates.error) lines.push(`  validation error: ${inlineText(result.validates.error)}`);
    for (const requirement of result.requirementsSynced.requirements) {
      lines.push(`    [${requirement.present ? 'synced' : 'missing'}] ${inlineText(requirement.domain)}/${inlineText(requirement.name)}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

function inlineText(value: string): string {
  return value.replaceAll('\r', '\\r').replaceAll('\n', '\\n');
}

function markdownCell(value: string): string {
  return value.replaceAll('|', '\\|').replaceAll('`', '\\`').replaceAll('\n', ' ');
}

export function renderStatusTable(results: ChangeStatusResult[]): string {
  return results.map((result) => {
    const evidence = [
      `marker ${result.marker.present ? 'present' : 'absent'}`,
      `requirements ${result.requirementsSynced.synced}/${result.requirementsSynced.total}`,
      `validates ${result.validates.passes ? 'yes' : 'no'}`,
      `tasks ${result.tasks.checked}/${result.tasks.total} (display only)`,
      ...(result.caveat ? [result.caveat] : []),
      ...(result.assessmentError ? [`assessment error: ${inlineText(result.assessmentError)}`] : []),
      EVIDENCE_DISCLAIMER,
    ].join('; ');
    // STATUS.md's human-owned table has two columns: Change | What it is. Keep
    // that shape so these body-only rows can be pasted without rewriting prose.
    return `| \`${markdownCell(result.name)}\` | ${markdownCell(`${result.verdict}; ${evidence}`)} |`;
  }).join('\n') + (results.length ? '\n' : '');
}

export interface ChangeStatusCliOptions {
  rootPath?: string;
  name?: string;
  json?: boolean;
  table?: boolean;
  validateChange?: ValidateChange;
}

export async function runChangeStatusCli(options: ChangeStatusCliOptions): Promise<number> {
  if (options.json && options.table) {
    process.stderr.write('change-status: --json and --table cannot be combined\n');
    return 1;
  }
  try {
    const results = await auditChangeStatuses({
      rootPath: options.rootPath ?? process.cwd(),
      name: options.name,
      validateChange: options.validateChange,
    });
    if (options.json) {
      await writeStdout(JSON.stringify({ evidenceDisclaimer: EVIDENCE_DISCLAIMER, changes: results }, null, 2) + '\n');
    } else if (options.table) {
      await writeStdout(renderStatusTable(results));
    } else {
      await writeStdout(renderHuman(results));
    }
    return 0;
  } catch (error) {
    process.stderr.write(`change-status: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

export const changeStatusCommand = new Command('change-status')
  .description('Compute open-change status from source markers, spec sync, and OpenSpec validation')
  .argument('[name]', 'Audit one open change (default: every open change)')
  .option('--json', 'Emit machine-readable evidence', false)
  .option('--table', 'Emit STATUS.md table rows only', false)
  .action(async (name: string | undefined, options: { json?: boolean; table?: boolean }) => {
    process.exitCode = await runChangeStatusCli({ name, json: options.json, table: options.table });
  });
