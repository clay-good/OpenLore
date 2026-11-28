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
import { ARTIFACT_SLIM_DIGEST } from '../../constants.js';

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
 * instruction set. The condition names the case where the lookup replaces work.
 * One line: the tool descriptions carry the rest (change: trim-standing-agent-instructions).
 */
function orientLine(available: ReadonlySet<string> | null): string {
  const call = available === null || available.has('orient')
    ? 'call `orient "<task>"`'
    : 'run `openlore orient "<task>"`';
  return `Before touching a module you have not yet read in this session, ${call}: it returns the relevant ` +
    'functions, callers, and specs in one lookup. Edits inside a file you already read do not need re-orientation.';
}

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
 * Build the MCP workflow section for the surface actually wired here: the `orient` line and
 * the decisions line, nothing more (change: trim-standing-agent-instructions). The generated
 * file is loaded on every turn, and each tool's own description already says when to use it.
 *
 * `available === null` means the full surface (every tool callable). When `record_decision`
 * is absent, the decisions line names the CLI and the command that exposes the tool, never
 * the tool as callable.
 */
function buildMcpSection(
  preset: string,
  available: ReadonlySet<string> | null,
  enablingCommand: string,
): string {
  const record = '`openlore decisions record --title "<decision>" --rationale "<why>"`';
  const decisions = available === null || available.has('record_decision')
    ? `When you make a significant design choice, call \`record_decision\` before writing the code (or run ${record}).`
    : `When you make a significant design choice, run ${record} before writing the code. ` +
      `\`record_decision\` is **not** part of the wired \`${preset}\` surface; \`${enablingCommand}\` exposes it.`;
  return [
    '## openlore MCP workflow',
    '',
    `_Written for the wired \`${preset}\` surface. Re-run \`openlore install --preset <name>\` after changing it so this section is regenerated._`,
    '',
    orientLine(available),
    '',
    decisions,
  ].join('\n');
}

/**
 * The "Architectural decisions" body for the wired surface: the MCP workflow when
 * `record_decision` is callable, otherwise the CLI form plus the enabling command.
 * Used by the decisions gate's agent-file block.
 */
export function buildDecisionsGuidance(
  preset: string,
  available: ReadonlySet<string> | null,
  enablingCommand: string,
): string {
  if (available === null || available.has('record_decision')) return DECISIONS_BODY;
  // Honest form: never prescribe a tool the agent cannot call. The CLI records
  // the same draft on any preset (change: add-decisions-record-cli).
  return [
    `\`record_decision\` is **not** part of the wired \`${preset}\` surface, so do not plan around calling it.`,
    '',
    'When making a significant design choice, record it with the CLI **before** writing the code:',
    '',
    '```bash',
    'openlore decisions record --title "Use JWTs for stateless auth" --rationale "Avoids session store in infra" \\',
    '  --consequences "Tokens can\'t be revoked early" --files src/auth/middleware.ts',
    '```',
    '',
    `To expose the MCP tool as well: \`${enablingCommand}\`  — then this section regenerates with the MCP workflow.`,
  ].join('\n');
}

function buildContent(
  analysisDir: string,
  projectName: string,
  forClaude: boolean,
  mcpSection: string,
  slimDigestExists: boolean,
): string {
  // With the slim digest, the prompt hook gives the agent repository shape once per session, so
  // the full digest is named, not loaded on every turn. Without it, the import is the only
  // repository shape the agent gets (change: trim-standing-agent-instructions).
  const digestRef = slimDigestExists
    ? `Full repository digest, for a task that needs it: \`${analysisDir}/CODEBASE.md\`.`
    : forClaude
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
  const slimDigestExists = await fileExists(join(rootDir, analysisDir, ARTIFACT_SLIM_DIGEST));

  return Promise.all(
    targets.map(async ({ rel, forClaude }) => {
      const absPath = join(rootDir, rel);
      const content = buildContent(analysisDir, projectName, forClaude, mcpSection, slimDigestExists);
      const created = await writeIfAbsent(absPath, content);
      return { rel, created };
    })
  );
}
