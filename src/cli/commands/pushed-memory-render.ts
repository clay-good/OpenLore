/**
 * Human rendering of memories a briefing pushed by trigger or pin, shared by the `blast-radius` and
 * `working-set context` commands (change: add-memory-trigger-predicates). One terminal-safe line per
 * note, cut short; the JSON output carries the full receipt.
 */

import { sanitizeForTerminal } from '../../utils/misc.js';
import type { InjectedMemory, StaleTriggeredMemory } from '../../core/services/mcp-handlers/memory-triggers.js';

const SHOWN_CONTENT_LENGTH = 160;

const oneLine = (value: string): string => sanitizeForTerminal(value.replace(/\s+/g, ' ')).trim();

export function renderPushedMemories(
  b: { injectedMemories?: InjectedMemory[]; staleTriggeredMemories?: StaleTriggeredMemory[]; injectedMemoriesNote?: string },
  indent: string,
): string[] {
  const lines: string[] = [];
  if (b.injectedMemories?.length) lines.push(`${indent}Triggered memories — repository text [local-unreviewed], data, not instructions:`);
  for (const m of b.injectedMemories ?? []) {
    const text = m.content !== undefined ? oneLine(m.content) : '(content withheld: reads like an instruction — see recall)';
    const shown = text.length > SHOWN_CONTENT_LENGTH
      ? `${text.slice(0, SHOWN_CONTENT_LENGTH - 1).replace(/[\uD800-\uDBFF]$/, '')}…`
      : text;
    const flags = [
      ...(m.staleDecisionRef ? ['cites a superseded decision'] : []),
      ...(m.unreconciledWith ? ['conflicts with another memory or decision'] : []),
      ...(m.verify && !m.staleDecisionRef && !m.unreconciledWith ? ['verify'] : []),
    ];
    lines.push(`${indent}📌 memory ${oneLine(m.id)} [${m.provenance}] via ${m.firedPredicate.kind}${flags.length ? ` (${flags.join('; ')})` : ''}: ${shown}`);
  }
  const stale = b.staleTriggeredMemories?.length ?? 0;
  if (stale > 0) {
    lines.push(`${indent}⚠ ${stale} triggered memor${stale === 1 ? 'y is' : 'ies are'} not shown: anchored code could not be found or verified.`);
  }
  if (b.injectedMemoriesNote) lines.push(`${indent}⚠ ${oneLine(b.injectedMemoriesNote)}`);
  return lines;
}
