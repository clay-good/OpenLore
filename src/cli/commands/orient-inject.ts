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
import {
  INJECTION_DEFAULTS,
  POINTER_LINE,
  resolveInjectionConfig,
  passesRelevanceGate,
  renderInjectionBlock,
  type LeanOrientResult,
} from './orient-inject-render.js';

// The pure presentation + gating layer lives in `orient-inject-render.ts` so a
// host that must not load the analyzer in-process (the Pi extension) can reuse
// it (decision abee8e3e). Re-export the public surface so existing importers and
// tests continue to resolve everything from this module.
export {
  INJECTION_DEFAULTS,
  POINTER_LINE,
  resolveInjectionConfig,
  passesRelevanceGate,
  renderInjectionBlock,
} from './orient-inject-render.js';
export type { ResolvedInjectionConfig, LeanOrientResult } from './orient-inject-render.js';

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
 *   - the full block when the relevance gate passes,
 *   - the pointer line otherwise (weak match, no graph, error, or empty prompt).
 *
 * Never throws: every failure path resolves to the pointer line so a hook that
 * invokes it cannot break the user's turn.
 */
export async function buildInjection(directory: string, prompt: string): Promise<string> {
  let cfg: ReturnType<typeof resolveInjectionConfig>;
  try {
    const loaded = await readOpenLoreConfig(directory);
    cfg = resolveInjectionConfig(loaded?.contextInjection);
  } catch {
    cfg = INJECTION_DEFAULTS;
  }

  if (cfg.mode === 'off') return '';

  const task = prompt.trim();
  if (!task) return POINTER_LINE;

  try {
    const result = (await handleOrient(directory, task, 8, undefined, true)) as LeanOrientResult;
    if (!passesRelevanceGate(result, cfg)) return POINTER_LINE;
    return renderInjectionBlock(result, cfg);
  } catch {
    return POINTER_LINE;
  }
}
