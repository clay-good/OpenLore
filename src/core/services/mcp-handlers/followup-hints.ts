/**
 * Data-dependent follow-up hints (change: add-conclusion-followup-hints).
 *
 * A conclusion payload often already holds the field that makes one specific next call warranted:
 * a search hit that is a hub, dead-code candidates at low confidence, a blast radius naming specs
 * that will go stale. {@link FOLLOWUP_HINT_RULES} is a CLOSED, source-declared table: each rule
 * names its tool, a predicate over a field already in that tool's payload, the tool it suggests,
 * and a message. A rule reads existing classifier outputs (`isHub`, `confidence`, a count) and
 * never introduces a threshold of its own.
 *
 * Hints are receipts, not advice: `{ tool, trigger: { field, value }, message }`, at most
 * {@link MAX_FOLLOWUP_HINTS} per response, in table order. They are attached at dispatch, the one
 * point every transport passes through, so no handler carries hint logic.
 */

export interface FollowupHint {
  /** The tool the hint suggests calling next. */
  tool: string;
  /** The payload field and value that fired the hint. */
  trigger: { field: string; value: unknown };
  message: string;
}

export interface FollowupHintRule {
  /** The tool whose response the rule reads. */
  forTool: string;
  /** The suggested tool. */
  tool: string;
  /** The payload field the rule reads, as written in the trigger. */
  field: string;
  /** The trigger value when the rule fires, else undefined. */
  fire(payload: Record<string, unknown>): unknown;
  message(value: unknown, payload: Record<string, unknown>): string;
}

export const MAX_FOLLOWUP_HINTS = 2;

function firstResult(p: Record<string, unknown>): Record<string, unknown> | undefined {
  const r = Array.isArray(p.results) ? p.results[0] : undefined;
  return r !== null && typeof r === 'object' ? r as Record<string, unknown> : undefined;
}

function positiveCount(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined;
}

export const FOLLOWUP_HINT_RULES: readonly FollowupHintRule[] = [
  {
    forTool: 'search_code',
    tool: 'analyze_impact',
    field: 'results[0].fanIn',
    fire: (p) => {
      const top = firstResult(p);
      return top?.isHub === true && typeof top.fanIn === 'number' ? top.fanIn : undefined;
    },
    message: (v, p) => `The top hit "${String(firstResult(p)?.name)}" is a hub (fanIn ${String(v)}): check its impact with analyze_impact before editing it.`,
  },
  {
    forTool: 'find_dead_code',
    tool: 'verify_claim',
    field: 'byConfidence.low',
    fire: (p) => positiveCount((p.byConfidence as Record<string, unknown> | undefined)?.low),
    message: (v) => `${String(v)} candidate(s) are low confidence (a blind spot may hide a caller): confirm one with verify_claim kind "dead" before deleting it.`,
  },
  {
    forTool: 'blast_radius',
    tool: 'check_spec_drift',
    field: 'specs.willGoStale',
    fire: (p) => positiveCount((p.specs as Record<string, unknown> | undefined)?.willGoStale),
    message: (v) => `${String(v)} spec(s) may go stale: check_spec_drift gives the per-requirement detail.`,
  },
];

/** The hints `toolName`'s payload fires, in table order, at most {@link MAX_FOLLOWUP_HINTS}. */
export function followupHints(toolName: string, payload: unknown): FollowupHint[] {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return [];
  const p = payload as Record<string, unknown>;
  if (p.error !== undefined) return [];
  const out: FollowupHint[] = [];
  for (const rule of FOLLOWUP_HINT_RULES) {
    if (rule.forTool !== toolName) continue;
    const value = rule.fire(p);
    if (value === undefined) continue;
    out.push({ tool: rule.tool, trigger: { field: rule.field, value }, message: rule.message(value, p) });
    if (out.length === MAX_FOLLOWUP_HINTS) break;
  }
  return out;
}

/** `payload` with a `followUp` array when a rule fires; otherwise `payload` unchanged. */
export function withFollowupHints(toolName: string, payload: unknown): unknown {
  const hints = followupHints(toolName, payload);
  return hints.length ? { ...(payload as Record<string, unknown>), followUp: hints } : payload;
}
