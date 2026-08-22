/**
 * `openlore install` — auto-configure popular agent surfaces so they call
 * `orient()` automatically.
 *
 * Dispatches to one or more adapters depending on `--agent` / detection,
 * supports `--dry-run`, `--force`, and `--uninstall`.
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Command } from 'commander';
import { logger } from '../../utils/logger.js';
import { FULL_PRESET, FULL_PRESET_ALIAS, LEAN_DEFAULT_PRESET } from '../../constants.js';
import { detect, ALL_AGENTS, type AgentName, type DetectedSurface } from './detect.js';
import type { Adapter, ApplyContext, ApplyResult, PlannedChange } from './adapters/types.js';
import { agentsMdAdapter } from './adapters/agents-md.js';
import { claudeCodeAdapter } from './adapters/claude-code.js';
import { cursorAdapter } from './adapters/cursor.js';
import { clineAdapter } from './adapters/cline.js';
import { continueAdapter } from './adapters/continue.js';
import type { ProveEligibility } from '../../core/agent-eval/tasks.js';

const ADAPTERS: Record<AgentName, Adapter> = {
  'agents-md': agentsMdAdapter,
  'claude-code': claudeCodeAdapter,
  cursor: cursorAdapter,
  cline: clineAdapter,
  continue: continueAdapter,
};

async function loadTemplate(): Promise<string> {
  // Template lives next to this file in the source tree, but at runtime we
  // resolve via the compiled dist path.
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, 'templates', 'agent-instructions.md'),
    // tsx / source-run fallback
    join(here, '..', '..', '..', 'src', 'cli', 'install', 'templates', 'agent-instructions.md'),
  ];
  for (const p of candidates) {
    try {
      return await readFile(p, 'utf8');
    } catch {
      /* try next */
    }
  }
  throw new Error(
    'openlore install: could not locate agent-instructions.md template (looked in dist + src)'
  );
}

export interface InstallOptions {
  agent?: AgentName;
  /**
   * Explicit list of surfaces to wire (used by `openlore connect`'s multi-select).
   * Takes precedence over `agent` and over detection. Each is rooted at `cwd`.
   */
  agents?: AgentName[];
  /** MCP tool preset wired into the registered server (validated against TOOL_PRESETS). */
  preset?: string;
  /** Convenience full-surface selector (alias of `--preset full`), matching `openlore mcp --all-tools`. */
  allTools?: boolean;
  dryRun?: boolean;
  force?: boolean;
  uninstall?: boolean;
  cwd?: string;
  /**
   * After configuring agent surfaces, build the index so orient() works on the
   * very first session (init if needed, then analyze). Default true; set false
   * via `--no-analyze`. Skipped for --dry-run and --uninstall.
   */
  analyze?: boolean;
}

/**
 * Build the openlore index so the freshly-wired orient() returns results on the
 * user's first session instead of "No analysis found".
 *
 * - init: use the programmatic API (openloreInit), which is silent and returns
 *   created:false when config already exists. The init CLI command instead logs
 *   a scary "[error] Configuration exists. Use --force" on re-runs, which is
 *   misleading inside install where re-running is a clean no-op.
 * - analyze: drive the real CLI command — the searchable BM25 index orient reads
 *   is built by analyze's embed step, which only the CLI command runs. It reads
 *   process.cwd(), so we chdir into the target for the duration.
 *
 * Failures are non-fatal: the surfaces are already wired, so we warn and tell
 * the user to run analyze themselves rather than failing the whole install.
 */
export async function buildIndex(cwd: string, opts: { repair?: boolean } = {}): Promise<boolean> {
  const prevCwd = process.cwd();
  // analyze prints its own multi-line CLI output ("Next step: run generate",
  // etc.) via console.log — noise inside install. Capture it to stderr so
  // install shows its own concise summary; logger.error still surfaces.
  const origLog = console.log;
  const toStderr = (...args: unknown[]): void => {
    process.stderr.write(args.map(a => (typeof a === 'string' ? a : String(a))).join(' ') + '\n');
  };
  try {
    const { openloreInit } = await import('../../api/init.js');
    // Silent + idempotent: creates config if absent, no-ops (created:false) if present.
    let freshSpecDirectory = false;
    await openloreInit({
      rootPath: cwd,
      onProgress: event => {
        if (event.step === 'Creating openspec directory' && event.status === 'complete') {
          freshSpecDirectory = true;
        }
      },
    });

    process.chdir(cwd);
    const { analyzeCommand } = await import('../commands/analyze.js');
    logger.discovery('Building search index (BM25; no network required)…');
    console.log = toStderr;
    // `--embedded`: install does the agent wiring (CLAUDE.md/.mcp.json/hooks) itself,
    // so analyze must NOT also print its agent-onboarding tips or the "run generate"
    // next-step — those contradict install's own output on the first-run path.
    // `--reanalyze` (background repair path): a mismatched/schema-reset index can have a
    // fingerprint that still matches source, so a plain analyze would skip the rebuild and
    // leave the index broken. `--reanalyze` guarantees the heal runs — and deliberately NOT
    // `--force`, which would additionally re-parse every file. What is broken here is the
    // STORE; the per-file extraction cache is keyed by content hash and is not implicated,
    // so re-parsing the repo would only make the most frequent repair path the slowest
    // (change: optimize-hash-keyed-analyze).
    // `analyzeCommand` is a module singleton that can be parsed more than once in a
    // process. Commander <13 RETAINED an option's value across parses, so a repair build
    // would leave `--reanalyze` set for every later cold-start build, silently defeating
    // the source-unchanged skip; Commander >=13 restores pre-parse state instead, which
    // fixes the leak but also DISCARDS anything set here before a second parse. Both lanes
    // are therefore driven by `analyzeArgs` below (the only mechanism both versions honor);
    // these two calls stay as the belt-and-braces guard for the first-parse case, where
    // they are still applied.
    analyzeCommand.setOptionValue('force', false);
    analyzeCommand.setOptionValue('reanalyze', opts.repair === true);
    const analyzeArgs = opts.repair ? ['--reanalyze', '--embedded'] : ['--embedded'];
    if (freshSpecDirectory) analyzeArgs.push('--fresh-spec-directory');
    // `process.exitCode` BEFORE the call, so a value analyze set is distinguishable from one that
    // was already there (a warning from an earlier step).
    const exitCodeBefore = process.exitCode;
    await analyzeCommand.parseAsync(analyzeArgs, { from: 'user' });
    console.log = origLog;

    // analyze reports its own failures by SETTING `process.exitCode` and returning, not by
    // throwing — so `parseAsync` resolves and the `catch` below never runs. Claiming success here
    // meant a repository whose index had genuinely failed to build was told "Index built", after
    // which `orient` silently returned nothing. Observed on a read-only `.openlore/` and on a full
    // disk, where the error line and the success line printed one after the other.
    if (process.exitCode !== undefined && process.exitCode !== 0 && process.exitCode !== exitCodeBefore) {
      logger.warning('The index did NOT finish building — see the error above.');
      logger.info('Next step', 'Fix the cause, then run "openlore analyze" so orient() works');
      return false;
    } else {
      logger.success('Index built — orient() will return results in your next session.');
      return true;
    }
  } catch (err) {
    console.log = origLog;
    logger.warning(
      `Could not build the index automatically: ${(err as Error).message}`
    );
    logger.info('Next step', 'Run "openlore analyze" so orient() works in your next session');
    return false;
  } finally {
    console.log = origLog;
    process.chdir(prevCwd);
  }
}

export interface SurfaceStatus {
  agent: AgentName;
  /** A marker for this agent was found in the project tree. */
  detected: boolean;
  /** OpenLore is already fully wired for this agent (a fresh apply would be a no-op). */
  connected: boolean;
}

/**
 * Status of every supported surface for `openlore connect list`. "connected" is
 * computed by asking each adapter to plan a dry-run apply and checking that it
 * has nothing left to create or update — reusing the adapters' own logic instead
 * of duplicating per-agent file knowledge here.
 */
export async function surfaceStatus(cwd?: string): Promise<SurfaceStatus[]> {
  const root = cwd ?? process.cwd();
  const detected = new Set((await detect(root)).map((s) => s.agent));
  const out: SurfaceStatus[] = [];
  for (const agent of ALL_AGENTS) {
    const connected = await ADAPTERS[agent].isConnected(root);
    out.push({ agent, detected: detected.has(agent), connected });
  }
  return out;
}

export async function runInstall(opts: InstallOptions): Promise<number> {
  const cwd = opts.cwd ?? process.cwd();
  const template = await loadTemplate();

  // Resolve the effective preset wired into the MCP server. `--all-tools` is the
  // convenience full-surface selector (matching `openlore mcp --all-tools`), and
  // the `all` alias is normalized to the canonical `full` so the wired arg in
  // .mcp.json is always the documented name — never two strings for one surface
  // (change: default-to-lean-tool-surface).
  const effectivePreset = opts.allTools
    ? FULL_PRESET
    : opts.preset === FULL_PRESET_ALIAS
      ? FULL_PRESET
      : opts.preset;

  // Validate the preset (only when given) against the real registry, without
  // pulling the heavy MCP module onto the common path. `full` is the opt-in
  // full-surface selector and is not an entry in TOOL_PRESETS (the full surface
  // is the registry itself), so accept it explicitly.
  if (effectivePreset && effectivePreset !== FULL_PRESET) {
    const { TOOL_PRESETS } = await import('../commands/mcp.js');
    if (!TOOL_PRESETS[effectivePreset]) {
      logger.error(
        `Unknown --preset "${opts.preset}". Known presets: ${[...Object.keys(TOOL_PRESETS), FULL_PRESET].join(', ')}.`
      );
      return 2;
    }
  }

  let surfaces: DetectedSurface[];
  if (opts.agents?.length) {
    const unknown = opts.agents.filter((a) => !ALL_AGENTS.includes(a));
    if (unknown.length) {
      logger.error(`Unknown agent surface(s) "${unknown.join(', ')}". Known: ${ALL_AGENTS.join(', ')}`);
      return 2;
    }
    surfaces = opts.agents.map((agent) => ({ agent, root: cwd, markers: ['(selected)'] }));
  } else if (opts.agent) {
    if (!ALL_AGENTS.includes(opts.agent)) {
      logger.error(`Unknown agent surface "${opts.agent}". Known: ${ALL_AGENTS.join(', ')}`);
      return 2;
    }
    surfaces = [{ agent: opts.agent, root: cwd, markers: ['(explicit --agent)'] }];
  } else {
    surfaces = await detect(cwd);
  }

  logger.discovery(
    `${opts.uninstall ? 'Uninstalling' : 'Installing'} for ${surfaces.length} surface(s): ${surfaces
      .map((s) => s.agent)
      .join(', ')}`
  );

  let conflict = false;
  const allChanges: PlannedChange[] = [];
  const allWarnings: string[] = [];

  // The guidance block names the surface it was written for, so a reader can tell
  // which tools it assumes — and so the block's fingerprint changes when the
  // preset does, making a re-install with a different preset rewrite it rather
  // than leave stale instructions in place
  // (change: align-generated-guidance-with-installed-preset).
  const guidancePreset = effectivePreset ?? LEAN_DEFAULT_PRESET;
  const instructionTemplate = `${template.trimEnd()}\n\nWired MCP surface: \`${guidancePreset}\`. ` +
    'This guidance is written for that surface; re-run `openlore install --preset <name>` to change it ' +
    'and regenerate these instructions.\n';

  for (const surface of surfaces) {
    const adapter = ADAPTERS[surface.agent];
    const ctx: ApplyContext = {
      root: surface.root,
      platform: process.platform,
      platformCommandRuntime: {
        nodeExecutable: process.execPath,
        npmExecPath: process.env.npm_execpath,
        pathValue: process.env.PATH,
        cwd: process.cwd(),
      },
      instructionTemplate,
      dryRun: !!opts.dryRun,
      force: !!opts.force,
      preset: effectivePreset,
    };
    const result: ApplyResult = opts.uninstall
      ? await adapter.uninstall(ctx)
      : await adapter.apply(ctx);

    if (result.conflict) conflict = true;
    allChanges.push(...result.changes);
    allWarnings.push(...result.warnings);
  }

  printSummary(allChanges, allWarnings, !!opts.dryRun, !!opts.uninstall);

  if (!opts.uninstall) {
    logger.info(
      'Wired surface',
      `\`${guidancePreset}\` — the generated guidance prescribes only tools this preset exposes`
    );
  }

  if (conflict) {
    logger.error(
      'Hand-edited OpenLore block(s) detected. Re-run with --force to overwrite, or revert your edits.'
    );
    return 1;
  }

  // One-command setup: build the index so orient() works on the first session.
  // Opt out with --no-analyze; never runs for dry-run or uninstall.
  const shouldAnalyze = opts.analyze !== false && !opts.dryRun && !opts.uninstall;
  if (shouldAnalyze) {
    const indexBuilt = await buildIndex(cwd);
    if (indexBuilt) await printProveGuidance(cwd);
  } else if (!opts.dryRun && !opts.uninstall) {
    // --no-analyze skipped init too, so a bare "openlore analyze" would fail
    // ("Run openlore init first"). Advise a sequence that actually works.
    logger.info(
      'Next step',
      'Run "openlore init && openlore analyze" to build the index (or "openlore install" to do it in one step) so orient() works in your next session'
    );
  }

  return 0;
}

function printSummary(
  changes: PlannedChange[],
  warnings: string[],
  dryRun: boolean,
  uninstall: boolean
): void {
  const verb = dryRun ? 'would' : 'did';
  for (const c of changes) {
    const tag =
      c.kind === 'create'
        ? `[${verb} create]`
        : c.kind === 'update'
          ? `[${verb} update]`
          : c.kind === 'delete'
            ? `[${verb} delete]`
            : '[noop]';
    if (c.kind === 'noop') logger.discovery(`${tag} ${c.summary}`);
    else logger.success(`${tag} ${c.summary}`);
    if (dryRun && c.preview) {
      const indented = c.preview
        .split('\n')
        .map((l) => '    ' + l)
        .join('\n');
      process.stderr.write(indented + '\n');
    }
  }
  for (const w of warnings) logger.warning(w);
  if (dryRun) {
    logger.discovery('Dry run — no files were written.');
  } else if (!uninstall) {
    logger.success('OpenLore install complete.');
  } else {
    logger.success('OpenLore uninstall complete.');
    logger.info(
      'Kept data',
      'The ".openlore/" directory remains (index, decisions, and memories). From the repository root, remove it with `rm -rf -- ./.openlore/` if you no longer need that data.'
    );
  }
}

/** Render install's value-proof epilogue only after checking the built graph. */
export async function printProveGuidance(cwd: string): Promise<void> {
  const { loadProveEligibility } = await import('../commands/prove.js');
  let eligibility: Awaited<ReturnType<typeof loadProveEligibility>>;
  try {
    eligibility = await loadProveEligibility(cwd);
  } catch {
    return;
  }
  if (!eligibility) return;
  const guidance = formatProveGuidance(eligibility);
  logger.info(guidance.title, guidance.detail);
}

export function formatProveGuidance(eligibility: ProveEligibility): { title: string; detail: string } {
  if (eligibility.eligible) {
    return {
      title: 'Does it pay off?',
      detail: 'Run "openlore prove --estimate" for a no-API-key projection on this repo (or "openlore prove" for a measured pass).',
    };
  }
  return {
    title: 'Measured projection unavailable',
    detail: `${eligibility.eligibleFunctions} functions have ≥${eligibility.minCallers} callers; ` +
      `${eligibility.requiredEligibleFunctions} is required. Nothing is wrong with the installation — ` +
      'skip this projection for this repo, or run it on a larger repo.',
  };
}

export const installCommand = new Command('install')
  .description(
    'One-command setup: configure agent surfaces (Claude Code, Cursor, Cline, Continue, AGENTS.md) ' +
    'to call orient(), then build the index so orient works on your first session.'
  )
  .option('--agent <name>', 'Install only for a specific surface (claude-code, cursor, cline, continue, agents-md)')
  .option('--preset <name>', `Wire the registered MCP server to a tool preset (navigation, substrate, minimal, memory, verify, federation, coordination, or full). Default (no preset) wires the "${LEAN_DEFAULT_PRESET}" surface — the navigation core, prepare_spec_generation + prepare_spec_repair, and the governance reads recall + verify_claim + blast_radius; "navigation" is the lean navigate-only escape; pass "full" to wire the full surface (the prior default).`)
  .option('--all-tools', 'Wire the full surface (alias of --preset full). Matches `openlore mcp --all-tools`.')
  .option('--dry-run', 'Print the planned changes without writing any files', false)
  .option('--force', 'Overwrite OpenLore-managed blocks even if hand-edited', false)
  .option('--uninstall', 'Remove OpenLore-managed blocks and entries', false)
  .option('--analyze', 'Build the index after configuring surfaces (default: true)', true)
  .option('--no-analyze', 'Configure surfaces only; do not run init/analyze (run "openlore analyze" yourself later)')
  .addHelpText(
    'after',
    `
Examples:
  $ openlore install                 Detect agents, wire them up, build the index
  $ openlore install --agent claude-code
  $ openlore install --no-analyze    Wire up surfaces only (skip index build)
  $ openlore install --dry-run       Preview changes without writing
  $ openlore install --uninstall     Remove OpenLore-managed entries

After install, orient() is available immediately — the configured MCP server
(\`openlore mcp\`) starts automatically when your agent launches, and the index
stays fresh as you edit (disable the file watcher with \`openlore mcp --no-watch-auto\`).
`
  )
  .action(async (opts: InstallOptions) => {
    const code = await runInstall(opts);
    if (code !== 0) process.exit(code);
  });
