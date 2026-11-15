/**
 * Task-scoped context injection (change: add-task-scoped-context-injection).
 *
 * `openlore orient --inject` is wired by `openlore install` as a per-task
 * pre-turn hook (Claude Code `UserPromptSubmit`). It runs `orient` for the
 * user's submitted prompt and emits a bounded, OpenLore-attributed, explicitly
 * ignorable orientation block to stdout, so the agent's first turn begins
 * already oriented to the task — amortizing the per-task `orient` round-trip to
 * zero rather than optimizing it.
 *
 * The block is a presentation-and-gating wrapper over the existing lean `orient`
 * output (Spec 27); there is no second orientation code path. It is deterministic
 * (no LLM), framed as facts-not-coercion (Epistemic Lease, decision 8e95746d),
 * and capped by a token budget so it can never dominate the context it economizes.
 *
 * Fail-open is load-bearing: a hook must never break the user's turn. Any
 * failure — missing graph, parse error, empty match, weak match, or empty
 * prompt — degrades to a single pointer line and exits 0.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { OPENLORE_ANALYSIS_REL_PATH } from '../../constants.js';
import { handleOrient } from '../../core/services/mcp-handlers/orient.js';
import { presetToolNames, resolveUserScopePreset, resolveWiredPreset } from '../../core/services/wired-preset.js';
import { readOpenLoreConfig } from '../../core/services/config-manager.js';
import { emit } from '../../core/services/telemetry.js';
import { proposalContextForPrompt } from './proposal-context.js';
import { errorReason } from '../../core/services/hook-health.js';
import {
  INJECTION_DEFAULTS,
  classifyTurnIntent,
  extractCodeAnchors,
  userWords,
  isHarnessEvent,
  keepExactAnchors,
  pointerLineFor,
  resolveInjectionConfig,
  evaluateRelevanceGate,
  renderInjectionBlock,
  type LeanOrientResult,
  type RelevanceGateEvaluation,
  type WithholdReason,
} from './orient-inject-render.js';

// The pure presentation + gating layer lives in `orient-inject-render.ts` so a
// host that must not load the analyzer in-process (the Pi extension) can reuse
// it (decision abee8e3e). Re-export the public surface so existing importers and
// tests continue to resolve everything from this module.
export {
  INJECTION_DEFAULTS,
  MIN_INJECTION_TOKEN_BUDGET,
  POINTER_LINE,
  classifyTurnIntent,
  isHarnessEvent,
  pointerLineFor,
  resolveInjectionConfig,
  evaluateRelevanceGate,
  passesRelevanceGate,
  renderInjectionBlock,
} from './orient-inject-render.js';
export type {
  ResolvedInjectionConfig,
  LeanOrientResult,
  RelevanceGateEvaluation,
  TurnIntent,
  WithholdReason,
  PointerReason,
} from './orient-inject-render.js';

/**
 * Extract the user's prompt from a hook stdin payload. Claude Code's
 * `UserPromptSubmit` hook passes a JSON object with a `prompt` field; other
 * harnesses may pass the raw prompt text. Returns '' when no usable prompt is
 * present (→ pointer line).
 */
export function extractPrompt(stdin: string): string {
  const raw = (stdin ?? '').trim();
  if (!raw) return '';
  if (raw.startsWith('{') || raw.startsWith('[')) {
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const p = parsed.prompt ?? parsed.user_prompt ?? parsed.message;
        return typeof p === 'string' ? p.trim() : '';
      }
    } catch {
      // Not JSON after all — fall through and treat as raw text.
    }
  }
  return raw;
}

/**
 * `orient --proposal-only` (the Codex prompt hook): the proposal instruction for a recognized
 * OpenSpec propose prompt, or ''. Honors the same `contextInjection.mode: "off"` opt-out as
 * `buildInjection`. Never throws.
 */
export async function buildProposalOnlyInjection(directory: string, prompt: string): Promise<string> {
  try {
    const loaded = await readOpenLoreConfig(directory);
    if (resolveInjectionConfig(loaded?.contextInjection).mode === 'off') return '';
  } catch {
    // An unreadable config falls back to the defaults, as buildInjection does.
  }
  return proposalContextForPrompt(prompt) ?? '';
}

/**
 * Top-level injection builder. Returns the string to emit on stdout:
 *   - '' when injection is disabled (`mode: "off"`) — the caller emits nothing,
 *   - the full block when both gates pass,
 *   - a reason-bearing pointer line on every gate withhold (management intent,
 *     weak match, no graph, or empty prompt),
 *   - '' when the lookup fails.
 *
 * Every gate withhold emits a line that names its cause and the manual `orient`
 * call, so the agent can always tell "nothing relevant was found" from "no
 * lookup was performed" (change: scope-advisory-noise-to-touched-code). A failed
 * lookup is silent instead: the agent is told nothing about OpenLore's own
 * failure, and the operator sees it in the hook's health (change: hook-reliability).
 *
 * Never throws, so a hook that invokes it cannot break the user's turn.
 */
export async function buildInjection(
  directory: string,
  prompt: string,
  onGateEvaluation?: (evaluation: RelevanceGateEvaluation) => void,
): Promise<string> {
  // A propose prompt keeps its normal task orientation; the proposal instruction is appended.
  const [task, proposal] = await Promise.all([
    buildTaskInjection(directory, prompt, onGateEvaluation),
    buildProposalOnlyInjection(directory, prompt),
  ]);
  if (!proposal) return task;
  return task ? `${task}\n\n${proposal}` : proposal;
}

async function buildTaskInjection(
  directory: string,
  prompt: string,
  onGateEvaluation?: (evaluation: RelevanceGateEvaluation) => void,
): Promise<string> {
  let cfg: ReturnType<typeof resolveInjectionConfig>;
  try {
    const loaded = await readOpenLoreConfig(directory);
    cfg = resolveInjectionConfig(loaded?.contextInjection);
  } catch {
    cfg = INJECTION_DEFAULTS;
  }

  if (cfg.mode === 'off') return '';

  const withhold = (reason: WithholdReason, failedCriteria: string[], error?: string): string => {
    const evaluation: RelevanceGateEvaluation = { passes: false, passedCriteria: [], failedCriteria, reason, ...(error ? { error } : {}) };
    onGateEvaluation?.(evaluation);
    recordInjectionVerdict(directory, evaluation);
    // Only a missing index is said here (once per session, by the caller); every other withhold is
    // silent, and the meaning of silence is stated once per session (change:
    // anchor-gated-prompt-briefing).
    return reason === 'no-graph' ? pointerLineFor('no-graph') : '';
  };

  const task = prompt.trim();
  if (!task) return withhold('empty-prompt', ['empty-prompt']);
  // A harness notice is not a turn: no lookup, and nothing said (change: hook-reliability).
  if (isHarnessEvent(task)) return withhold('harness-event', ['harness-event']);

  // The intent gate runs BEFORE any structural lookup: a turn about pushing,
  // merging, or releasing needs no briefing, so orienting it is pure cost. It
  // fails open — only positive management evidence with no code-work signal
  // withholds — so a misjudged turn loses the pre-computed briefing, never the
  // ability to ask for one.
  if (cfg.intentGate && classifyTurnIntent(task) === 'repository-management') {
    return withhold('management-intent', ['turn-intent']);
  }

  // Brief only the code the prompt names: an anchor (a symbol, a path, a `backticked` name). Prose
  // alone is never searched — a keyword search over a request matched unrelated hubs on real
  // prompts (change: anchor-gated-prompt-briefing).
  // The anchor gate decides before any lookup, so check for an index first: a missing one is still
  // stated (the caller says it once per session).
  if (!existsSync(join(directory, OPENLORE_ANALYSIS_REL_PATH, 'llm-context.json'))) return withhold('no-graph', ['no-graph']);
  const anchors = extractCodeAnchors(userWords(task));
  if (anchors.length === 0) return withhold('no-anchor', ['no-anchor']);

  try {
    const found = (await handleOrient(directory, anchors.join(' '), 8, undefined, true, 'distance', { pushMemories: true, repoWideParseHealth: false })) as LeanOrientResult;
    if (found.error) {
      const evaluation = evaluateRelevanceGate(found, cfg);
      onGateEvaluation?.(evaluation);
      recordInjectionVerdict(directory, evaluation);
      return evaluation.reason === 'no-graph' ? pointerLineFor('no-graph') : '';
    }
    const exact = keepExactAnchors(found, anchors);
    if (!exact) return withhold('no-anchor', ['anchor-unresolved']);
    const result = exact;
    result.suggestedTools = found.suggestedTools;
    // Suggest only tools the wired MCP surface exposes (default surface when unwired).
    const wired = await resolveWiredPreset(directory);
    const preset = wired.source === 'default' ? (await resolveUserScopePreset()) ?? wired.preset : wired.preset;
    const available = await presetToolNames(preset);
    if (available && result.suggestedTools) {
      result.suggestedTools = result.suggestedTools.filter((t) => available.has(t));
    }
    // An exact anchor is the relevance evidence: nothing else is shown.
    const evaluation: RelevanceGateEvaluation = { passes: true, passedCriteria: ['exact-anchor'], failedCriteria: [] };
    onGateEvaluation?.(evaluation);
    recordInjectionVerdict(directory, evaluation);
    return renderInjectionBlock(result, cfg);
  } catch (error) {
    // A failed lookup is silent: a hook says nothing about OpenLore's own failure, and the agent
    // keeps its turn (change: hook-reliability). The verdict is still recorded for telemetry, and
    // what failed goes to hook health.
    return withhold('error', ['orient-error'], errorReason(error));
  }
}

/**
 * Attribute the injection verdict (opt-in telemetry only — a no-op unless
 * OPENLORE_TELEMETRY=1). Records WHY a briefing was withheld so the gate's own
 * error rate is measurable rather than assumed: a rising `management-intent`
 * share on a repo where users complain about missing context is the signal that
 * the classifier is wrong. Never throws.
 */
function recordInjectionVerdict(directory: string, evaluation: RelevanceGateEvaluation): void {
  emit(directory, 'inject', {
    event: 'injection_verdict',
    verdict: evaluation.passes ? 'injected' : 'withheld',
    reason: evaluation.reason ?? null,
    passed_criteria: evaluation.passedCriteria,
    failed_criteria: evaluation.failedCriteria,
  });
}
