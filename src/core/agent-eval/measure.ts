/**
 * Agent measurement core (Spec 25 Phase D / Q2) — shipped so `openlore prove`
 * can run a WITH/WITHOUT pass on the user's own repo and print a personal
 * token-value scorecard. The live agent call is behind an injectable runner so
 * the deterministic parts (JSON parsing, aggregation) are unit-tested without
 * spending API budget; the default runner shells out to `claude -p`, mirroring
 * the Spec 14 benchmark harness exactly.
 */

import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type Condition = 'with' | 'without';

export interface Metrics {
  /** input_tokens + cache_creation — what the model processed fresh. */
  freshInputTokens: number;
  /** cache_read_input_tokens — ~10× cheaper amortized reads. */
  cacheReadTokens: number;
  outputTokens: number;
  costUsd: number;
  /** num_turns — round-trips, the most consistent WITH/WITHOUT signal. */
  numTurns: number;
  durationMs: number;
  answer: string;
  correct: boolean;
  error?: string;
}

/** Coerce any value to a finite number, falling back to 0 (NaN/Infinity/non-numeric → 0). */
const finite = (v: unknown): number => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};

/**
 * Parse a `claude -p --output-format json` result blob into raw metrics (no
 * scoring). Every numeric is coerced through `finite()` so a malformed agent
 * payload (e.g. a non-numeric `total_cost_usd`) can never propagate NaN/Infinity
 * downstream into the scorecard or the JSON contract.
 */
export function parseAgentJson(raw: string): Omit<Metrics, 'correct'> {
  const j = JSON.parse(raw) as Record<string, unknown>;
  const usage = (j.usage ?? {}) as Record<string, number>;
  const fresh = finite(usage.input_tokens) + finite(usage.cache_creation_input_tokens);
  return {
    freshInputTokens: fresh,
    cacheReadTokens: finite(usage.cache_read_input_tokens),
    outputTokens: finite(usage.output_tokens),
    costUsd: finite(j.total_cost_usd),
    numTurns: finite(j.num_turns),
    durationMs: finite(j.duration_ms),
    answer: String(j.result ?? ''),
  };
}

export interface AgentRunInput {
  prompt: string;
  mcpConfigPath: string;
  cwd: string;
  model: string;
  maxBudgetUsd: number;
  /** Appended only on the WITH arm — the shipped orient nudge. */
  systemPrompt?: string;
}

/** Pluggable agent invoker — returns the raw stdout JSON. Default = `claude -p`. */
export type AgentRunner = (input: AgentRunInput) => string;

const ORIENT_NUDGE =
  'This project uses OpenLore for architectural memory. BEFORE reading source files, call the ' +
  'openlore `orient` tool (mcp__openlore__orient) with your task — it returns the relevant ' +
  'functions, their callers, matching specs, and insertion points in one call. If you are reading ' +
  'source files without having called orient first, you are probably wasting tokens.';

/** Default runner: shell out to the `claude` CLI (mirrors the Spec 14 harness). */
export const claudeRunner: AgentRunner = (input) => {
  const args = [
    '-p', input.prompt,
    '--output-format', 'json',
    '--model', input.model,
    '--max-budget-usd', String(input.maxBudgetUsd),
    '--no-session-persistence',
    '--permission-mode', 'bypassPermissions',
    '--disallowedTools', 'WebSearch', 'WebFetch',
    '--strict-mcp-config',
    '--mcp-config', input.mcpConfigPath,
  ];
  if (input.systemPrompt) args.push('--append-system-prompt', input.systemPrompt);
  try {
    return execFileSync('claude', args, { cwd: input.cwd, encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024, windowsHide: true });
  } catch (err) {
    // Some non-zero exits still emit the result JSON on stdout.
    const e = err as { stdout?: Buffer | string };
    const out = e.stdout ? e.stdout.toString() : '';
    if (out.trim()) return out;
    throw err;
  }
};

/** Write the WITH (openlore navigation) + WITHOUT (empty) strict-mcp configs. */
export function writeProveMcpConfigs(
  workDir: string,
  cliEntry: string,
): { withPath: string; withoutPath: string; systemPrompt: string } {
  const withPath = join(workDir, 'openlore-prove-with.json');
  writeFileSync(
    withPath,
    JSON.stringify(
      { mcpServers: { openlore: { command: 'node', args: [cliEntry, 'mcp', '--no-watch-auto', '--preset', 'navigation'] } } },
      null, 2,
    ),
    'utf-8',
  );
  const withoutPath = join(workDir, 'openlore-prove-without.json');
  writeFileSync(withoutPath, JSON.stringify({ mcpServers: {} }, null, 2), 'utf-8');
  return { withPath, withoutPath, systemPrompt: ORIENT_NUDGE };
}

export const median = (xs: number[]): number => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

export interface Cell {
  costUsd: number;
  freshInputTokens: number;
  cacheReadTokens: number;
  numTurns: number;
  durationMs: number;
  correctRate: number;
  runs: number;
}

/** Median-aggregate N runs of one arm into a comparable cell. */
export function summarize(runs: Metrics[]): Cell {
  return {
    costUsd: median(runs.map(r => r.costUsd)),
    freshInputTokens: median(runs.map(r => r.freshInputTokens)),
    cacheReadTokens: median(runs.map(r => r.cacheReadTokens)),
    numTurns: median(runs.map(r => r.numTurns)),
    durationMs: median(runs.map(r => r.durationMs)),
    correctRate: runs.length ? runs.filter(r => r.correct).length / runs.length : 0,
    runs: runs.length,
  };
}
