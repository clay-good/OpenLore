/**
 * openlore setup command
 *
 * Installs workflow skills and agent integration files into the current project.
 * Unlike `analyze --ai-configs` (which generates project-specific context files),
 * `setup` copies static workflow assets that are the same for every project:
 *
 *   - Mistral Vibe skills  -> .vibe/skills/openlore-{name}/SKILL.md      (10 skills)
 *   - Cline workflows      -> .clinerules/workflows/openlore-{name}.md
 *   - Claude Code skills   -> .claude/skills/openlore-{name}/SKILL.md    (10 skills)
 *   - OpenCode skills      -> .opencode/skills/openlore-{name}/SKILL.md  (10 skills)
 *   - GSD commands         -> .claude/commands/gsd/openlore-{name}.md
 *
 * Files are never overwritten — existing files are skipped silently.
 * Canonical skills are read from `skills/`; other integration assets remain under `examples/`.
 */

import { Command } from 'commander';
import { readFile, writeFile, mkdir, access, unlink, lstat, realpath } from 'node:fs/promises';
import { join, dirname, relative, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { checkbox } from '@inquirer/prompts';
import { logger } from '../../utils/logger.js';
import { installPreCommitHook, uninstallClaudeHook } from './decisions.js';
import { readOpenLoreConfig, writeOpenLoreConfig } from '../../core/services/config-manager.js';
import { validatePanicSignal, readPanicTelemetry } from '../../core/services/mcp-handlers/panic-validation.js';
import type { PanicGateReport } from '../../core/services/mcp-handlers/panic-validation.js';
import type { PanicResponseMode } from '../../types/index.js';
import { atomicWriteFile } from '../../core/decisions/atomic-store.js';

// ============================================================================
// TYPES
// ============================================================================

type ToolName = 'vibe' | 'cline' | 'gsd' | 'bmad' | 'claude' | 'opencode' | 'omoa' | 'pi';

interface SkillEntry {
  /** Absolute source path inside the package */
  src: string;
  /** Relative destination path from the project root */
  dest: string;
}

interface SetupResult {
  tool: ToolName;
  rel: string;
  status: 'created' | 'updated' | 'skipped';
}

// ============================================================================
// HELPERS
// ============================================================================

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Root of the openlore package (dist/cli/commands -> ../../.. -> package root) */
const PACKAGE_ROOT = join(__dirname, '../../..');

async function fileExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Detect whether oh-my-openagent is installed in the project or user config.
 * Checks both the legacy oh-my-opencode and the renamed oh-my-openagent basenames.
 */
async function detectOmoa(projectRoot: string): Promise<boolean> {
  const home = homedir();
  const candidates = [
    // Project-level config
    join(projectRoot, '.opencode', 'oh-my-openagent.jsonc'),
    join(projectRoot, '.opencode', 'oh-my-openagent.json'),
    join(projectRoot, '.opencode', 'oh-my-opencode.jsonc'),
    join(projectRoot, '.opencode', 'oh-my-opencode.json'),
    // User-level config
    join(home, '.config', 'opencode', 'oh-my-openagent.jsonc'),
    join(home, '.config', 'opencode', 'oh-my-openagent.json'),
    join(home, '.config', 'opencode', 'oh-my-opencode.jsonc'),
    join(home, '.config', 'opencode', 'oh-my-opencode.json'),
  ];
  for (const p of candidates) {
    if (await fileExists(p)) return true;
  }

  // Also check if opencode.json plugin list references oh-my-openagent / oh-my-opencode
  for (const opencodeJson of [
    join(home, '.config', 'opencode', 'opencode.json'),
    join(projectRoot, '.opencode', 'opencode.json'),
    join(projectRoot, 'opencode.json'),
  ]) {
    try {
      const raw = await readFile(opencodeJson, 'utf-8');
      if (raw.includes('oh-my-openagent') || raw.includes('oh-my-opencode')) return true;
    } catch {
      /* file not found */
    }
  }

  return false;
}

async function copyFile(
  src: string,
  dest: string,
  force: boolean,
  transform?: (content: string) => string,
): Promise<'created' | 'updated' | 'skipped'> {
  const exists = await fileExists(dest);
  if (exists && !force) return 'skipped';
  const raw = await readFile(src, 'utf-8');
  const content = transform ? transform(raw) : raw;
  await mkdir(dirname(dest), { recursive: true });
  await writeFile(dest, content, 'utf-8');
  return exists ? 'updated' : 'created';
}

/** Add only metadata required by a specific host, keeping canonical skills portable. */
export function adaptSkillForHost(content: string, host: ToolName): string {
  if (host !== 'vibe' || /^user-invocable:/m.test(content)) return content;
  return content.replace(/^(name:\s*[^\n]+)$/m, '$1\nuser-invocable: true');
}

// ============================================================================
// SKILL MANIFESTS
// ============================================================================

export function buildManifest(projectRoot: string, piGlobal = false): Record<ToolName, SkillEntry[]> {
  const ex = join(PACKAGE_ROOT, 'examples');

  const VIBE_SKILLS = [
    'openlore-analyze-codebase',
    'openlore-brainstorm',
    'openlore-debug',
    'openlore-execute-refactor',
    'openlore-generate',
    'openlore-repair',
    'openlore-implement-story',
    'openlore-plan-refactor',
    'openlore-review-changes',
    'openlore-write-tests',
  ];

  const OPENCODE_SKILLS = VIBE_SKILLS;
  const skillSource = (name: string): string => join(PACKAGE_ROOT, 'skills', name, 'SKILL.md');

  const CLINE_WORKFLOWS = [
    'openlore-analyze-codebase.md',
    'openlore-check-spec-drift.md',
    'openlore-execute-refactor.md',
    'openlore-implement-feature.md',
    'openlore-plan-refactor.md',
    'openlore-refactor-codebase.md',
    'openlore-write-tests.md',
  ];

  const GSD_COMMANDS = ['openlore-orient.md', 'openlore-drift.md'];

  const BMAD_AGENTS = ['architect.md', 'dev-brownfield.md'];
  const BMAD_TASKS = ['implement-story.md', 'onboarding.md', 'refactor.md', 'sprint-planning.md'];

  return {
    vibe: VIBE_SKILLS.map((name) => ({
      src: skillSource(name),
      dest: join(projectRoot, '.vibe', 'skills', name, 'SKILL.md'),
    })),
    cline: CLINE_WORKFLOWS.map((file) => ({
      src: join(ex, 'cline-workflows', file),
      dest: join(projectRoot, '.clinerules', 'workflows', file),
    })),
    gsd: GSD_COMMANDS.map((file) => ({
      src: join(ex, 'gsd', 'commands', 'gsd', file),
      dest: join(projectRoot, '.claude', 'commands', 'gsd', file),
    })),
    bmad: [
      ...BMAD_AGENTS.map((file) => ({
        src: join(ex, 'bmad', 'agents', file),
        dest: join(projectRoot, '_bmad', 'openlore', 'agents', file),
      })),
      ...BMAD_TASKS.map((file) => ({
        src: join(ex, 'bmad', 'tasks', file),
        dest: join(projectRoot, '_bmad', 'openlore', 'tasks', file),
      })),
    ],
    claude: OPENCODE_SKILLS.map((name) => ({
      src: skillSource(name),
      dest: join(projectRoot, '.claude', 'skills', name, 'SKILL.md'),
    })),
    opencode: [
      ...OPENCODE_SKILLS.map((name) => ({
        src: skillSource(name),
        dest: join(projectRoot, '.opencode', 'skills', name, 'SKILL.md'),
      })),
      {
        src: join(ex, 'opencode', 'agent-guard.ts'),
        dest: join(projectRoot, '.opencode', 'plugins', 'agent-guard.ts'),
      },
    ],
    omoa: [
      // SDD enforcement plugins
      {
        src: join(ex, 'opencode', 'plugins', 'anti-laziness.ts'),
        dest: join(projectRoot, '.opencode', 'plugins', 'anti-laziness.ts'),
      },
      {
        src: join(ex, 'opencode', 'plugins', 'openlore-enforcer.ts'),
        dest: join(projectRoot, '.opencode', 'plugins', 'openlore-enforcer.ts'),
      },
      {
        src: join(ex, 'opencode', 'plugins', 'openlore-decision-extractor.ts'),
        dest: join(projectRoot, '.opencode', 'plugins', 'openlore-decision-extractor.ts'),
      },
      {
        src: join(ex, 'opencode', 'plugins', 'lib', 'openlore-decision-extractor-helpers.ts'),
        dest: join(
          projectRoot,
          '.opencode',
          'plugins',
          'lib',
          'openlore-decision-extractor-helpers.ts'
        ),
      },
      {
        src: join(ex, 'opencode', 'plugins', 'openlore-context-injector.ts'),
        dest: join(projectRoot, '.opencode', 'plugins', 'openlore-context-injector.ts'),
      },
      {
        src: join(ex, 'opencode', 'plugins', 'lib', 'openlore-context-injector-helpers.ts'),
        dest: join(
          projectRoot,
          '.opencode',
          'plugins',
          'lib',
          'openlore-context-injector-helpers.ts'
        ),
      },
      // Sisyphus SDD system prompt
      {
        src: join(ex, 'opencode', 'prompts', 'sisyphus-sdd.md'),
        dest: join(projectRoot, '.opencode', 'prompts', 'sisyphus-sdd.md'),
      },
    ],
    // Pi (pi.dev) — compiled JS extension from dist/pi/. Project-local by default;
    // --global installs it for every project via ~/.pi/agent/extensions/.
    pi: [
      {
        src: join(PACKAGE_ROOT, 'dist', 'pi', 'extension.js'),
        dest: piGlobal
          ? join(homedir(), '.pi', 'agent', 'extensions', 'openlore.js')
          : join(projectRoot, '.pi', 'extensions', 'openlore.js'),
      },
    ],
  };
}

// ============================================================================
// CORE
// ============================================================================

async function runSetup(
  projectRoot: string,
  tools: ToolName[],
  force: boolean,
  piGlobal = false
): Promise<SetupResult[]> {
  const manifest = buildManifest(projectRoot, piGlobal);
  const results: SetupResult[] = [];

  for (const tool of tools) {
    for (const entry of manifest[tool]) {
      if (!(await fileExists(entry.src))) {
        logger.warning(`setup: source not found — ${entry.src} (re-install openlore to fix)`);
        continue;
      }
      // Remove the old .ts counterpart when installing the .js Pi extension.
      // Prior versions of setup distributed openlore.ts; Pi loads all files in the
      // extensions dir, so both registering the same tools causes a conflict.
      if (tool === 'pi' && entry.dest.endsWith('.js')) {
        const oldTs = entry.dest.slice(0, -3) + '.ts';
        if (await fileExists(oldTs)) await unlink(oldTs);
      }
      const status = await copyFile(
        entry.src,
        entry.dest,
        force,
        /[/\\]SKILL\.md$/.test(entry.dest) ? content => adaptSkillForHost(content, tool) : undefined,
      );
      const rel = entry.dest.startsWith(projectRoot)
        ? entry.dest.slice(projectRoot.length).replace(/^\//, '')
        : entry.dest;
      results.push({ tool, rel, status });
    }
  }

  return results;
}

// ============================================================================
// COMMAND
// ============================================================================

// ============================================================================
// PANIC HOOKS (opt-in) — install the behavioral-governance hooks into Claude
// Code settings. Never installed by default; only via `setup --hooks <format>`.
// ============================================================================

const PANIC_CHECK_HOOK_MARKER = 'openlore panic-check';
const GRYPH_WATCH_HOOK_MARKER = 'openlore gryph-watch';
const CHECK_EDIT_HOOK_MARKER = 'openlore check-edit --hook';

/** Sentinel written by `setup --panic off|observe`. When present, the guarded PreToolUse hook skips
 *  spawning Node entirely (the hook is a pure no-op in those modes) — off/observe cost nothing per
 *  tool call. Its ABSENCE means "run" (fail-safe: existing installs and direct config edits still
 *  run the hook), so only the setup path opts into the cheap fast-exit. */
const PANIC_DISABLED_SENTINEL = 'panic-check-disabled';

/** The PreToolUse hook command: a POSIX-sh guard that runs panic-check only when the disabled
 *  sentinel is absent, and always exits 0 (a non-zero PreToolUse exit could be read as a denial). */
export function panicCheckHookCommand(format: string): string {
  return `test -f "$(pwd)/.openlore/${PANIC_DISABLED_SENTINEL}" || openlore panic-check --directory "$(pwd)" --format ${format} || true`;
}

export { PANIC_DISABLED_SENTINEL };

/**
 * Decide whether `setup --panic <mode>` may activate an interventional mode. Pure and deterministic
 * so it is testable without touching the filesystem or process. Non-interventional modes (off,
 * observe) always pass. An interventional mode is allowed only when the accuracy gate has CLEARED,
 * or the operator passed `--acknowledge-unvalidated`; otherwise it is refused with the unmet
 * criteria named (never a silent refusal, never a silent activation).
 */
export function evaluatePanicActivation(
  mode: PanicResponseMode,
  report: PanicGateReport,
  acknowledgeUnvalidated: boolean,
): { allow: boolean; interventional: boolean; unmet: string[] } {
  const interventional = mode === 'advisory' || mode === 'experimental_blocking';
  if (!interventional) return { allow: true, interventional: false, unmet: [] };
  const c = report.criteria;
  const unmet: string[] = [];
  if (!c.data_sufficient) unmet.push(`insufficient data (${report.episodes.completed}/${report.min_episodes} completed episodes)`);
  if (c.fp_ok === false) unmet.push('false-positive proxy above target (upper bound)');
  if (c.follow_through_ok === false) unmet.push('intervention follow-through below target');
  if (c.follow_through_ok === null && c.data_sufficient) unmet.push('follow-through unmeasured (no interventions observed yet)');
  const allow = report.verdict === 'CLEARED' || acknowledgeUnvalidated;
  return { allow, interventional, unmet };
}

interface ClaudeHookSettings {
  hooks?: {
    PreToolUse?: Array<{ _comment?: string; [key: string]: unknown }>;
    PostToolUse?: Array<{ _comment?: string; [key: string]: unknown }>;
    UserPromptSubmit?: Array<{ _comment?: string; [key: string]: unknown }>;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

/** Install the read-only per-edit verdict consumer as a Claude Code PostToolUse hook. */
export async function installCheckEditHook(rootPath: string): Promise<boolean> {
  const settingsPath = await verifiedCheckEditSettingsPath(rootPath, true);
  if (!settingsPath) return false;
  let settings: ClaudeHookSettings;
  try { settings = await readClaudeSettings(settingsPath); }
  catch (e) { logger.error((e as Error).message); return false; }

  if (settings.hooks !== undefined &&
      (settings.hooks === null || typeof settings.hooks !== 'object' || Array.isArray(settings.hooks))) {
    logger.error(`${settingsPath} has a non-object hooks field — refusing to overwrite it.`);
    return false;
  }
  if (settings.hooks?.PostToolUse !== undefined && !Array.isArray(settings.hooks.PostToolUse)) {
    logger.error(`${settingsPath} has a non-array hooks.PostToolUse field — refusing to overwrite it.`);
    return false;
  }

  const hooks = settings.hooks?.PostToolUse ?? [];
  const hookEntry = {
    matcher: 'Edit|Write|MultiEdit|NotebookEdit',
    _openlore: true,
    hooks: [{ type: 'command', command: CHECK_EDIT_HOOK_MARKER }],
  };
  const existing = hooks.findIndex((entry) => JSON.stringify(entry).includes(CHECK_EDIT_HOOK_MARKER));
  if (existing !== -1 && JSON.stringify(hooks[existing]) === JSON.stringify(hookEntry)) {
    logger.success('check-edit PostToolUse hook already present in .claude/settings.json');
    return true;
  }

  const next = hooks.filter((entry) => !JSON.stringify(entry).includes(CHECK_EDIT_HOOK_MARKER));
  if (existing === -1) next.push(hookEntry);
  else next.splice(Math.min(existing, next.length), 0, hookEntry);
  settings.hooks ??= {};
  settings.hooks.PostToolUse = next;
  const verifiedWritePath = await verifiedCheckEditSettingsPath(rootPath, true);
  if (!verifiedWritePath || verifiedWritePath !== settingsPath) return false;
  await atomicWriteFile(settingsPath, JSON.stringify(settings, null, 2) + '\n');
  logger.success('check-edit PostToolUse hook added to .claude/settings.json');
  return true;
}

/** Remove only OpenLore's check-edit PostToolUse entry, preserving user hooks. */
export async function uninstallCheckEditHook(rootPath: string): Promise<boolean> {
  const settingsPath = await verifiedCheckEditSettingsPath(rootPath, false);
  if (!settingsPath) return !(await fileExists(join(rootPath, '.claude')));
  if (!(await fileExists(settingsPath))) return true;
  let settings: ClaudeHookSettings;
  try { settings = await readClaudeSettings(settingsPath); }
  catch (e) { logger.error((e as Error).message); return false; }

  const hooks = settings.hooks?.PostToolUse;
  if (hooks !== undefined && !Array.isArray(hooks)) {
    logger.error(`${settingsPath} has a non-array hooks.PostToolUse field — refusing to overwrite it.`);
    return false;
  }
  if (!hooks) return true;
  const filtered = hooks.filter((entry) => !JSON.stringify(entry).includes(CHECK_EDIT_HOOK_MARKER));
  if (filtered.length === hooks.length) return true;
  if (filtered.length === 0) delete settings.hooks!.PostToolUse;
  else settings.hooks!.PostToolUse = filtered;
  const verifiedWritePath = await verifiedCheckEditSettingsPath(rootPath, false);
  if (!verifiedWritePath || verifiedWritePath !== settingsPath) return false;
  await atomicWriteFile(settingsPath, JSON.stringify(settings, null, 2) + '\n');
  logger.success('Removed the check-edit PostToolUse hook from .claude/settings.json');
  return true;
}

/** Thrown when settings.json exists but is unparseable — we must NOT overwrite user content. */
class CorruptSettingsError extends Error {}

function isContainedPath(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel !== '..' && !rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(rel);
}

/** Resolve the check-edit hook settings destination without following a user-controlled
 * `.claude` directory or `settings.json` symlink. The destination is checked again
 * immediately before the atomic rename so an observed escape is always refused. */
async function verifiedCheckEditSettingsPath(rootPath: string, createDirectory: boolean): Promise<string | undefined> {
  let root: string;
  try { root = await realpath(rootPath); }
  catch {
    logger.error(`setup --check-edit-hook: repository root is missing or unreadable — refusing to write.`);
    return undefined;
  }
  const claudeDir = join(root, '.claude');
  try {
    const info = await lstat(claudeDir);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      logger.error(`${claudeDir} is not a real in-repository directory — refusing to write hook settings.`);
      return undefined;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || !createDirectory) return undefined;
    await mkdir(claudeDir);
  }
  let canonicalDir: string;
  try { canonicalDir = await realpath(claudeDir); }
  catch {
    logger.error(`${claudeDir} is missing or unreadable — refusing to write hook settings.`);
    return undefined;
  }
  if (!isContainedPath(root, canonicalDir)) {
    logger.error(`${claudeDir} resolves outside the repository — refusing to write hook settings.`);
    return undefined;
  }
  const settingsPath = join(canonicalDir, 'settings.json');
  try {
    const info = await lstat(settingsPath);
    if (info.isSymbolicLink() || !info.isFile()) {
      logger.error(`${settingsPath} is not a regular in-repository file — refusing to overwrite it.`);
      return undefined;
    }
    const canonicalSettings = await realpath(settingsPath);
    if (!isContainedPath(root, canonicalSettings)) {
      logger.error(`${settingsPath} resolves outside the repository — refusing to overwrite it.`);
      return undefined;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      logger.error(`${settingsPath} is unreadable — refusing to overwrite it.`);
      return undefined;
    }
  }
  return settingsPath;
}

async function readClaudeSettings(settingsPath: string): Promise<ClaudeHookSettings> {
  let raw: string;
  try {
    raw = await readFile(settingsPath, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw new CorruptSettingsError(`${settingsPath} is unreadable — refusing to overwrite it.`);
  }
  if (raw.trim() === '') return {}; // empty file → start fresh
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('settings root is not an object');
    }
    return parsed as ClaudeHookSettings;
  } catch {
    // Exists with content but is invalid JSON — refuse to clobber the user's file.
    throw new CorruptSettingsError(
      `${settingsPath} exists but is not a valid JSON settings object — refusing to overwrite it. Fix or remove the file, then re-run.`,
    );
  }
}

/** Install `openlore panic-check` as a PreToolUse hook (idempotent). */
export async function installPanicCheckHook(rootPath: string, format: string = 'claude'): Promise<void> {
  const settingsPath = join(rootPath, '.claude', 'settings.json');
  let settings: ClaudeHookSettings;
  try { settings = await readClaudeSettings(settingsPath); }
  catch (e) { logger.error((e as Error).message); return; }
  const hooks = settings.hooks?.PreToolUse ?? [];
  const hookEntry = {
    _comment: 'openlore: behavioral destabilization guard — fires before every tool call (skips spawning Node when panic is off/observe)',
    type: 'command',
    command: panicCheckHookCommand(format),
  };
  // Replace an existing openlore entry in place so a re-run with a DIFFERENT --format
  // actually updates the command (the marker is format-independent), rather than
  // silently keeping the stale one.
  const existingIdx = hooks.findIndex((h) => JSON.stringify(h).includes(PANIC_CHECK_HOOK_MARKER));
  if (existingIdx !== -1) {
    if ((hooks[existingIdx] as { command?: string }).command === hookEntry.command) {
      logger.success('panic-check PreToolUse hook already present in .claude/settings.json');
      return;
    }
    const updated = [...hooks];
    updated[existingIdx] = hookEntry;
    settings.hooks ??= {};
    settings.hooks.PreToolUse = updated;
    await mkdir(join(rootPath, '.claude'), { recursive: true });
    await writeFile(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf-8');
    logger.success(`panic-check PreToolUse hook updated to format: ${format}`);
    return;
  }
  settings.hooks ??= {};
  settings.hooks.PreToolUse = [...hooks, hookEntry];
  await mkdir(join(rootPath, '.claude'), { recursive: true });
  await writeFile(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf-8');
  logger.success(`panic-check PreToolUse hook added to .claude/settings.json (format: ${format})`);
}

/** Install `openlore gryph-watch` as a UserPromptSubmit hook (idempotent). */
export async function installGryphWatchHook(rootPath: string): Promise<void> {
  const settingsPath = join(rootPath, '.claude', 'settings.json');
  let settings: ClaudeHookSettings;
  try { settings = await readClaudeSettings(settingsPath); }
  catch (e) { logger.error((e as Error).message); return; }
  const hooks = settings.hooks?.UserPromptSubmit ?? [];
  if (hooks.some((h) => JSON.stringify(h).includes(GRYPH_WATCH_HOOK_MARKER))) {
    logger.success('gryph-watch UserPromptSubmit hook already present in .claude/settings.json');
    return;
  }
  const hookEntry = {
    _comment: 'openlore: start Gryph behavioral observer (singleton, background)',
    type: 'command',
    command: 'openlore gryph-watch &',
  };
  settings.hooks ??= {};
  settings.hooks.UserPromptSubmit = [...hooks, hookEntry];
  await mkdir(join(rootPath, '.claude'), { recursive: true });
  await writeFile(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf-8');
  logger.success('gryph-watch UserPromptSubmit hook added to .claude/settings.json');
}

/** Remove the opt-in panic-check + gryph-watch hooks (idempotent — the inverse of
 *  `setup --hooks <format>`). Only strips openlore-marked entries; leaves user hooks. */
export async function uninstallPanicHooks(rootPath: string): Promise<void> {
  const settingsPath = join(rootPath, '.claude', 'settings.json');
  if (!(await fileExists(settingsPath))) return;
  let settings: ClaudeHookSettings;
  try { settings = await readClaudeSettings(settingsPath); }
  catch (e) { logger.error((e as Error).message); return; }

  let changed = false;
  const strip = (key: 'PreToolUse' | 'UserPromptSubmit', marker: string): void => {
    const arr = settings.hooks?.[key];
    if (!arr) return;
    const filtered = arr.filter((h) => !JSON.stringify(h).includes(marker));
    if (filtered.length === arr.length) return;
    changed = true;
    if (filtered.length === 0) delete settings.hooks![key];
    else settings.hooks![key] = filtered;
  };
  strip('PreToolUse', PANIC_CHECK_HOOK_MARKER);
  strip('UserPromptSubmit', GRYPH_WATCH_HOOK_MARKER);

  if (!changed) {
    logger.success('No openlore panic hooks found in .claude/settings.json');
    return;
  }
  await writeFile(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf-8');
  logger.success('Removed openlore panic hooks (panic-check + gryph-watch) from .claude/settings.json');
}

/** Set panicResponse.mode in .openlore/config.json. Returns true on success. */
async function setPanicMode(rootPath: string, mode: string, acknowledgeUnvalidated: boolean): Promise<boolean> {
  const valid: PanicResponseMode[] = ['off', 'observe', 'advisory', 'experimental_blocking'];
  if (!valid.includes(mode as PanicResponseMode)) {
    logger.error(`Unknown panic mode "${mode}". Valid: ${valid.join(', ')}`);
    return false;
  }
  const cfg = await readOpenLoreConfig(rootPath);
  if (!cfg) {
    logger.error('setup --panic: no .openlore/config.json found. Run `openlore init` first.');
    return false;
  }

  // Interventional modes consult the accuracy gate. Activation is never silent: if the gate has not
  // CLEARED, it is refused with the unmet criteria named, unless the operator says so explicitly.
  const report = validatePanicSignal(readPanicTelemetry(rootPath));
  const decision = evaluatePanicActivation(mode as PanicResponseMode, report, acknowledgeUnvalidated);
  const interventional = decision.interventional;
  if (interventional && !decision.allow) {
    logger.error(
      `setup --panic ${mode}: the panic accuracy gate has not CLEARED (verdict ${report.verdict}) — declining to activate an interventional mode.`,
    );
    logger.error(`  Unmet: ${decision.unmet.length ? decision.unmet.join('; ') : 'see `openlore panic-validate`'}`);
    logger.error('  Review with `openlore panic-validate`, or re-run with `--acknowledge-unvalidated` to activate anyway (recorded).');
    return false;
  }

  cfg.panicResponse = { mode: mode as PanicResponseMode };
  await writeOpenLoreConfig(rootPath, cfg);

  // Off-mode cheapness: in off/observe the PreToolUse hook is a pure no-op, so drop the disabled
  // sentinel and the guarded hook skips spawning Node entirely. Interventional modes clear it.
  const sentinelPath = join(rootPath, '.openlore', PANIC_DISABLED_SENTINEL);
  try {
    if (interventional) { await unlink(sentinelPath).catch(() => {}); }
    else { await writeFile(sentinelPath, 'panic-check disabled in off/observe mode — remove to force the hook to run\n', 'utf-8'); }
  } catch { /* sentinel is a best-effort fast-path optimization — never fail setup over it */ }

  logger.success(`panic response mode set to "${mode}" in .openlore/config.json`);
  if (interventional) {
    if (report.verdict === 'CLEARED') {
      logger.success('Accuracy gate CLEARED — interventional mode enabled.');
    } else {
      logger.warning(`Interventional mode enabled WITHOUT a CLEARED accuracy gate (verdict ${report.verdict}, --acknowledge-unvalidated). Validate with \`openlore panic-validate\`.`);
    }
  }
  return true;
}

export const setupCommand = new Command('setup')
  .description(
    'Install workflow skills and agent integration files into this project.\n' +
      'Copies static assets from the openlore package — safe to re-run (skips existing files).'
  )
  .option(
    '--tools <list>',
    'Comma-separated list of tools to install: vibe, cline, claude, opencode, gsd, bmad, pi (default: all)'
  )
  .option(
    '--force',
    'Overwrite existing files (use after upgrading openlore to pull in updated skills)',
    false
  )
  .option('--dir <path>', 'Project root directory', process.cwd())
  .option('--global', 'For the pi target: install the extension to ~/.pi/agent/extensions/ instead of the project', false)
  .option('--hooks <format>', 'Install the opt-in panic-check + gryph-watch hooks for the given agent format: claude|kilo|codex (use "none" to remove them)')
  .option('--check-edit-hook <mode>', 'Install the read-only per-edit verdict hook: claude|none')
  .option('--panic <mode>', 'Set panic response mode in .openlore/config.json: off|observe|advisory|experimental_blocking')
  .option('--acknowledge-unvalidated', 'Activate an interventional panic mode even though the accuracy gate has not CLEARED (recorded)', false)
  .action(async (options: { tools?: string; force: boolean; dir: string; global: boolean; hooks?: string; checkEditHook?: string; panic?: string; acknowledgeUnvalidated: boolean }) => {
    const projectRoot = options.dir;

    // Opt-in panic setup — runs independently of skill install and needs no TTY.
    if (options.panic !== undefined) {
      const ok = await setPanicMode(projectRoot, options.panic, options.acknowledgeUnvalidated);
      if (!ok) process.exit(1);
    }
    if (options.hooks) {
      if (options.hooks === 'none' || options.hooks === 'off') {
        await uninstallPanicHooks(projectRoot); // inverse of --hooks <format>
      } else {
        const validFormats = ['claude', 'kilo', 'codex'];
        const fmt = validFormats.includes(options.hooks) ? options.hooks : 'claude';
        if (!validFormats.includes(options.hooks)) logger.warning(`Unknown hooks format "${options.hooks}" — defaulting to "claude"`);
        await installPanicCheckHook(projectRoot, fmt);
        await installGryphWatchHook(projectRoot);
      }
    }
    if (options.checkEditHook) {
      let ok: boolean;
      if (options.checkEditHook === 'none' || options.checkEditHook === 'off') {
        ok = await uninstallCheckEditHook(projectRoot);
      } else if (options.checkEditHook === 'claude') {
        ok = await installCheckEditHook(projectRoot);
      } else {
        logger.error(`Unknown check-edit hook mode "${options.checkEditHook}". Valid: claude, none`);
        process.exitCode = 1;
        return;
      }
      if (!ok) { process.exitCode = 1; return; }
      // This explicit lifecycle request is self-contained; do not unexpectedly
      // continue into the interactive skill picker when no tools were requested.
      if (!options.tools && !options.hooks && options.panic === undefined) return;
    }
    // If only panic flags were requested (no skill install), we're done — don't prompt.
    if (!options.tools && (options.hooks || options.checkEditHook || options.panic !== undefined) && !process.stdout.isTTY) {
      return;
    }
    const allTools: ToolName[] = ['vibe', 'cline', 'gsd', 'bmad', 'claude', 'opencode', 'omoa', 'pi'];

    let tools: ToolName[];
    if (options.tools) {
      tools = (options.tools.split(',').map((t) => t.trim()) as ToolName[]).filter((t) =>
        allTools.includes(t)
      );
      if (tools.length === 0) {
        logger.error(
          'setup: no valid tools specified. Valid values: vibe, cline, gsd, bmad, claude, opencode, omoa, pi'
        );
        process.exit(1);
      }
    } else if (process.stdout.isTTY) {
      const omoaDetected = await detectOmoa(projectRoot);
      if (omoaDetected) {
        console.log('  ✦ oh-my-openagent detected — SDD plugins available.\n');
      }

      const selected = await checkbox({
        message: 'Which agent tools do you want to install skills for?',
        choices: [
          {
            name: 'Claude Code   (.claude/skills/ — 10 skills + pre-commit hook)',
            value: 'claude' as ToolName,
          },
          {
            name: 'Cline / Roo   (.clinerules/workflows/openlore-{name}.md — 7 workflows)',
            value: 'cline' as ToolName,
          },
          {
            name: 'Mistral Vibe  (.vibe/skills/openlore-{name}/SKILL.md — 10 skills)',
            value: 'vibe' as ToolName,
          },
          {
            name: 'OpenCode      (.opencode/skills/openlore-{name}/SKILL.md — 10 skills + agent-guard plugin)',
            value: 'opencode' as ToolName,
          },
          {
            name: 'GSD           (.claude/commands/gsd/openlore-{name}.md — 2 commands)',
            value: 'gsd' as ToolName,
          },
          {
            name: 'BMAD          (_bmad/openlore/{agents,tasks}/ — 2 agents, 4 tasks)',
            value: 'bmad' as ToolName,
          },
          {
            name: `oh-my-openagent  (.opencode/plugins/ — SDD enforcement: anti-laziness, enforcer, decision-extractor)${omoaDetected ? ' ← detected' : ''}`,
            value: 'omoa' as ToolName,
            checked: omoaDetected,
          },
          {
            name: 'Pi            (.pi/extensions/openlore.js — warm-daemon extension; --global for ~/.pi)',
            value: 'pi' as ToolName,
          },
        ],
      });
      if (selected.length === 0) {
        console.log('Nothing selected — exiting.');
        process.exit(0);
      }
      tools = selected;
    } else {
      logger.error(
        'setup requires an interactive terminal.\n' +
          'Use --tools to specify which to install.\n' +
          'Example: openlore setup --tools claude,cline,omoa'
      );
      process.exit(1);
    }

    logger.success(`Installing workflow skills into ${projectRoot}`);

    let results: SetupResult[];
    try {
      results = await runSetup(projectRoot, tools, options.force, options.global);
    } catch (err) {
      logger.error(`setup failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
      return;
    }

    if (tools.includes('claude')) {
      await installPreCommitHook(projectRoot);
      // Freshness is owned by the MCP server's --watch-auto (Spec 13.1); strip
      // any legacy full-analyze PostToolUse hook a prior version installed (B9).
      await uninstallClaudeHook(projectRoot);
    }

    // ── Report ───────────────────────────────────────────────────────────────
    const byTool: Record<string, SetupResult[]> = {};
    for (const r of results) {
      (byTool[r.tool] ??= []).push(r);
    }

    const LABELS: Record<ToolName, string> = {
      vibe: 'Mistral Vibe',
      cline: 'Cline / Roo Code',
      claude: 'Claude Code',
      opencode: 'OpenCode',
      gsd: 'get-shit-done (GSD)',
      bmad: 'BMAD',
      omoa: 'oh-my-openagent (SDD plugins)',
      pi: 'Pi (pi.dev)',
    };

    for (const tool of tools) {
      const entries = byTool[tool] ?? [];
      const created = entries.filter((e) => e.status === 'created').length;
      const updated = entries.filter((e) => e.status === 'updated').length;
      const skipped = entries.filter((e) => e.status === 'skipped').length;
      console.log(`\n${LABELS[tool as ToolName]}`);
      for (const e of entries) {
        const marker =
          e.status === 'created' ? '✓ created' : e.status === 'updated' ? '↑ updated' : '– exists ';
        console.log(`  ${marker} ${e.rel}`);
      }
      if (entries.length === 0) {
        logger.warning('  (no source files found — check openlore installation)');
      } else {
        console.log(`  ${created} created, ${updated} updated, ${skipped} already up-to-date`);
      }
    }

    const totalChanged = results.filter((r) => r.status !== 'skipped').length;
    if (totalChanged > 0) {
      logger.success(`${totalChanged} file(s) installed.`);
      console.log(
        'Run `openlore analyze --ai-configs` to also generate project-specific context files (CLAUDE.md, .cursorrules, etc.).'
      );
    } else {
      console.log(
        '\nAll files already up-to-date. Use --force to overwrite with the latest version.'
      );
    }

    if (tools.includes('omoa')) {
      console.log(`
┌─ oh-my-openagent SDD plugins installed ────────────────────────────────────┐
│                                                                              │
│  Wire the Sisyphus SDD prompt in your oh-my-openagent config:               │
│                                                                              │
│  ~/.config/opencode/oh-my-openagent.jsonc  (or .opencode/oh-my-openagent)  │
│                                                                              │
│  {                                                                           │
│    "agents": {                                                               │
│      "sisyphus": {                                                           │
│        "prompt_append": "file://.opencode/prompts/sisyphus-sdd.md"          │
│      }                                                                       │
│    }                                                                         │
│  }                                                                           │
│                                                                              │
│  Plugins loaded automatically from .opencode/plugins/ by OpenCode.           │
│  decision-extractor uses the Librarian agent — configure it in your config:  │
│    "agents": { "librarian": { "model": "google/gemini-3-flash" } }          │
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘`);
    }
  });
