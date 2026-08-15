/**
 * AI Config File Generator
 *
 * Generates tool-specific AI context files during `openlore analyze`:
 *   - .cursorrules            (Cursor IDE)
 *   - .clinerules/openlore.md (Cline / Roo Code / Kilocode)
 *   - CLAUDE.md               (Claude Code)
 *   - .github/copilot-instructions.md  (GitHub Copilot)
 *   - .windsurf/rules.md      (Windsurf)
 *
 * Files are NEVER overwritten — if a file already exists it is skipped silently.
 * Returns the list of paths that were actually created.
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileExists } from '../../utils/command-helpers.js';
import { resolveWiredPreset, presetToolNames, enablingCommandFor } from '../services/wired-preset.js';

// ============================================================================
// TYPES
// ============================================================================

/** Supported AI assistant targets */
export type AiTool = 'claude' | 'cursor' | 'cline' | 'copilot' | 'windsurf' | 'vibe' | 'agents';

export interface AiConfigOptions {
  /** Absolute path to the project root */
  rootDir: string;
  /** Relative path to the analysis output directory (e.g. ".openlore/analysis") */
  analysisDir: string;
  /** Project name shown in the generated header */
  projectName: string;
  /**
   * Which tools to generate configs for.
   * Defaults to all tools if omitted.
   */
  tools?: AiTool[];
  /**
   * The wired MCP preset the guidance is written for. Omitted = read from the
   * repository's MCP registration (or the documented default when unwired), so
   * the guidance can never prescribe a tool the agent cannot call
   * (change: align-generated-guidance-with-installed-preset).
   */
  preset?: string;
}

// ============================================================================
// TOOL REGISTRY
// ============================================================================

interface ToolTarget {
  tool: AiTool;
  /** Display label shown in the interactive prompt */
  label: string;
  /** Relative path from project root */
  rel: string;
  /** Use @-import syntax (Claude Code) vs HTML comment */
  forClaude: boolean;
}

export const AI_TOOL_TARGETS: ToolTarget[] = [
  { tool: 'claude',   label: 'Claude Code    (CLAUDE.md)',                        rel: 'CLAUDE.md',                              forClaude: true  },
  { tool: 'cursor',   label: 'Cursor         (.cursorrules)',                      rel: '.cursorrules',                           forClaude: false },
  { tool: 'cline',    label: 'Cline / Roo    (.clinerules/openlore.md)',           rel: '.clinerules/openlore.md',                forClaude: false },
  { tool: 'copilot',  label: 'GitHub Copilot (.github/copilot-instructions.md)',  rel: '.github/copilot-instructions.md',        forClaude: false },
  { tool: 'windsurf', label: 'Windsurf       (.windsurf/rules.md)',               rel: '.windsurf/rules.md',                     forClaude: false },
  { tool: 'vibe',    label: 'Mistral Vibe   (.vibe/skills/openlore.md)',          rel: '.vibe/skills/openlore.md',               forClaude: false },
  { tool: 'agents',  label: 'OpenAI Codex  (AGENTS.md)',                          rel: 'AGENTS.md',                              forClaude: false },
];

// ============================================================================
// TEMPLATE
// ============================================================================

/**
 * The orientation rule, stated as a CONDITION rather than an absolute
 * (change: align-generated-guidance-with-installed-preset).
 *
 * "ALWAYS call orient before reading source files" was routinely ignored on the
 * work it does not fit — repeated edits inside one already-read file — and an
 * instruction that is routinely ignored teaches the agent to discount the whole
 * instruction set, including the turns where orienting would have paid. The
 * condition names the case where the lookup actually replaces work.
 */
const ORIENT_GUIDANCE = `
## When to orient

Call \`orient "<task description>"\` **before touching a module you have not yet read
in this session**, and when a task spans several modules. It returns the relevant
functions, callers, spec sections, and insertion points in one lookup instead of
file-by-file rediscovery.

Skip it for work you are already inside: repeated edits to a file you have read this
session do not need re-orientation. Reach for it again when the task moves to
unfamiliar code.
`.trim();

/** One workflow entry in the generated guidance, with the tools it needs to be callable. */
interface GuidanceEntry {
  /** Tools this entry instructs the agent to call. */
  requires: string[];
  /** Rendered when every required tool is available. */
  render: () => string;
}

const WORKFLOW_ENTRIES: GuidanceEntry[] = [
  {
    requires: ['get_schema_inventory', 'get_route_inventory', 'get_env_vars', 'get_ui_component_inventory', 'get_middleware_inventory'],
    render: () => '- **Data models, APIs, or config** — `get_schema_inventory` · `get_route_inventory` · `get_env_vars` · `get_ui_component_inventory` · `get_middleware_inventory`',
  },
  { requires: ['trace_execution_path'], render: () => '- **Debugging a call flow** ("how does X reach Y?") — `trace_execution_path`' },
  { requires: ['get_subgraph'], render: () => '- **Before modifying a function** — `get_subgraph` for blast radius' },
  { requires: ['blast_radius'], render: () => '- **Weighing a diff before committing** — `blast_radius`' },
  { requires: ['check_spec_drift'], render: () => '- **Before opening a PR** — `check_spec_drift`' },
  { requires: ['recall'], render: () => '- **Touching code others have reasoned about** — `recall` for anchored notes and decisions' },
  { requires: ['verify_claim'], render: () => '- **About to assert a structural fact to a human** — `verify_claim`, then cite the receipt' },
  {
    requires: ['prepare_spec_generation'],
    render: () => '- **Creating a domain spec** — `prepare_spec_generation <domain>`, exhaust continuation cursors, then author and validate with the host editor',
  },
  {
    requires: ['prepare_spec_repair'],
    render: () => '- **Repairing an existing spec** — `prepare_spec_repair <domain>`, honor unavailable evidence, then reconcile and validate with the host editor',
  },
];

const ON_DEMAND_TOOLS = [
  'search_code', 'suggest_insertion_points', 'get_spec', 'search_specs',
  'analyze_impact', 'get_function_body', 'get_function_skeleton', 'find_path', 'get_map',
];

const DECISIONS_BODY = `
When making a significant design choice, call \`record_decision\` **before** writing the code.

Significant choices: data structure, library/dependency, API contract, auth strategy, module boundary, database schema, caching approach, error handling pattern.

\`\`\`
record_decision({
  title: "Use JWTs for stateless auth",         // short imperative
  rationale: "Avoids session store in infra",   // why this choice
  consequences: "Tokens can't be revoked early", // trade-offs
  affectedFiles: ["src/auth/middleware.ts"],    // optional
  supersedes: "a1b2c3d4"                        // 8-char ID of prior decision being reversed
})
\`\`\`

Decisions are consolidated in the background immediately after \`record_decision\` is called — the pre-commit gate reads the already-consolidated store and adds no LLM latency.

**Performance note**: if you skip \`record_decision\`, the gate detects unrecorded source changes at commit time and triggers a slow LLM extraction on the *next* commit (~10-30s). Calling \`record_decision\` proactively keeps every commit instant. Do not record trivial choices (variable names, formatting).
`.trim();

/**
 * Build the MCP workflow section for the surface actually wired here.
 *
 * `available === null` means the full surface (every tool callable). Otherwise an
 * entry whose tools are absent is dropped, and the decisions workflow — the one
 * whose absence silently blocked a task — is kept but rewritten as a prerequisite
 * with the exact command that enables it, never as a callable instruction.
 */
function buildMcpSection(
  preset: string,
  available: ReadonlySet<string> | null,
  enablingCommand: string,
): string {
  const has = (tool: string) => available === null || available.has(tool);
  const lines: string[] = ['## openlore MCP workflow', ''];

  lines.push(`_Written for the wired \`${preset}\` surface. Re-run \`openlore install --preset <name>\` after changing it so this section is regenerated._`, '');

  if (has('orient')) {
    lines.push(ORIENT_GUIDANCE, '');
  }

  const entries = WORKFLOW_ENTRIES.filter(e => e.requires.every(has))
    .map(e => e.render());
  if (entries.length) {
    lines.push('**Then, by situation:**', '', ...entries, '');
  }
  if (has('prepare_spec_generation') || has('prepare_spec_repair')) {
    lines.push('Use the specification composites directly; do not routinely reconstruct them by replaying atomic tools.', '');
  }

  const onDemand = ON_DEMAND_TOOLS.filter(has);
  if (onDemand.length) {
    lines.push(`**On-demand** (when orient's results aren't enough): ${onDemand.map(t => `\`${t}\``).join(' · ')}`, '');
  }

  lines.push('## Architectural decisions', '');
  if (has('record_decision')) {
    lines.push(DECISIONS_BODY);
  } else {
    // Honest form: state the prerequisite instead of prescribing a tool the
    // agent cannot call. This is the exact failure this change exists to fix.
    lines.push(
      `\`record_decision\` is **not** part of the wired \`${preset}\` surface, so the decision-recording workflow is unavailable in this repository.`,
      '',
      `To enable it: \`${enablingCommand}\`  — then this section regenerates with the full workflow.`,
      '',
      'Until then, do not plan around `record_decision`: it will not be callable.',
    );
  }

  return lines.join('\n').trimEnd();
}

function buildContent(
  analysisDir: string,
  projectName: string,
  forClaude: boolean,
  mcpSection: string,
): string {
  const digestRef = forClaude
    ? `@${analysisDir}/CODEBASE.md`
    : `<!-- Import or paste ${analysisDir}/CODEBASE.md here for full project context -->`;

  return [
    `# ${projectName} — AI context (generated by openlore)`,
    '',
    digestRef,
    '',
    mcpSection,
  ].join('\n');
}

// ============================================================================
// HELPERS
// ============================================================================

async function writeIfAbsent(filePath: string, content: string): Promise<boolean> {
  if (await fileExists(filePath)) return false;
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, content, 'utf-8');
  return true;
}

// ============================================================================
// PUBLIC API
// ============================================================================

/**
 * Generate AI tool config files in the project root.
 * Skips any file that already exists.
 *
 * @param options.tools - Which assistants to generate for. Defaults to all.
 * @returns Relative paths (from rootDir) of files that were actually created.
 */
export interface AiConfigResult {
  /** Relative path from rootDir */
  rel: string;
  /** true = created now, false = already existed */
  created: boolean;
}

export async function generateAiConfigs(options: AiConfigOptions): Promise<AiConfigResult[]> {
  const { rootDir, analysisDir, projectName, tools } = options;

  const targets = tools
    ? AI_TOOL_TARGETS.filter(t => tools.includes(t.tool))
    : AI_TOOL_TARGETS;

  // Resolve the wired surface ONCE for this generation pass: every file written
  // here describes the same repository, so they must not disagree about which
  // tools are callable (change: align-generated-guidance-with-installed-preset).
  const wired = options.preset
    ? { preset: options.preset, source: 'caller' }
    : await resolveWiredPreset(rootDir);
  const available = await presetToolNames(wired.preset);
  const enablingCommand = await enablingCommandFor('record_decision', wired.preset);
  const mcpSection = buildMcpSection(wired.preset, available, enablingCommand);

  return Promise.all(
    targets.map(async ({ rel, forClaude }) => {
      const absPath = join(rootDir, rel);
      const content = buildContent(analysisDir, projectName, forClaude, mcpSection);
      const created = await writeIfAbsent(absPath, content);
      return { rel, created };
    })
  );
}
