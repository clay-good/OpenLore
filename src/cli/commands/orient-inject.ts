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

import { handleOrient } from '../../core/services/mcp-handlers/orient.js';
import { readOpenLoreConfig } from '../../core/services/config-manager.js';
import { emit } from '../../core/services/telemetry.js';
import {
  INJECTION_DEFAULTS,
  classifyTurnIntent,
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
 * Top-level injection builder. Returns the string to emit on stdout:
 *   - '' when injection is disabled (`mode: "off"`) — the caller emits nothing,
 *   - the full block when both gates pass,
 *   - a reason-bearing pointer line on every other path (management intent,
 *     weak match, no graph, error, or empty prompt).
 *
 * NEVER SILENT while injection is enabled: `mode: "off"` is the only path that
 * returns ''. Every withhold — including every failure — emits a line that names
 * its cause and the manual `orient` call, so the agent can always tell "nothing
 * relevant was found" from "no lookup was performed" (change:
 * scope-advisory-noise-to-touched-code).
 *
 * Never throws: every failure path resolves to the pointer line so a hook that
 * invokes it cannot break the user's turn.
 */
export async function buildInjection(
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

  const withhold = (reason: WithholdReason, failedCriteria: string[]): string => {
    const evaluation: RelevanceGateEvaluation = { passes: false, passedCriteria: [], failedCriteria, reason };
    onGateEvaluation?.(evaluation);
    recordInjectionVerdict(directory, evaluation);
    return pointerLineFor(reason);
  };

  const task = prompt.trim();
  if (!task) return withhold('empty-prompt', ['empty-prompt']);

  // The intent gate runs BEFORE any structural lookup: a turn about pushing,
  // merging, or releasing needs no briefing, so orienting it is pure cost. It
  // fails open — only positive management evidence with no code-work signal
  // withholds — so a misjudged turn loses the pre-computed briefing, never the
  // ability to ask for one.
  if (cfg.intentGate && classifyTurnIntent(task) === 'repository-management') {
    return withhold('management-intent', ['turn-intent']);
  }

  try {
    const result = (await handleOrient(directory, task, 8, undefined, true)) as LeanOrientResult;
    const evaluation = evaluateRelevanceGate(result, cfg);
    onGateEvaluation?.(evaluation);
    recordInjectionVerdict(directory, evaluation);
    if (!evaluation.passes) return pointerLineFor(evaluation.reason ?? 'weak-relevance');
    return renderInjectionBlock(result, cfg);
  } catch {
    return withhold('error', ['orient-error']);
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
