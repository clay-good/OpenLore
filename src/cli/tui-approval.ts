/**
 * Interactive TUI for reviewing and approving architectural decisions
 * at pre-commit time. Uses readline raw mode — no additional dependencies.
 *
 * Only activated when stdout is a TTY. Falls back to plain text otherwise.
 */

import * as readline from 'node:readline';
import type { PendingDecision } from '../types/index.js';
import { sanitizeForTerminal as safe } from '../utils/misc.js';

const C = {
  reset:   '\x1b[0m',
  bold:    '\x1b[1m',
  dim:     '\x1b[2m',
  green:   '\x1b[32m',
  yellow:  '\x1b[33m',
  red:     '\x1b[31m',
  cyan:    '\x1b[36m',
  bg:      '\x1b[44m',
  clear:   '\x1b[2J\x1b[H',
  up:      (n: number) => `\x1b[${n}A`,
  eraseLine: '\x1b[2K\r',
};

function wrap(text: string, width: number, indent: string): string {
  const words = text.split(' ');
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    if ((line + word).length > width) {
      if (line) lines.push(line.trimEnd());
      line = indent + word + ' ';
    } else {
      line += word + ' ';
    }
  }
  if (line.trim()) lines.push(line.trimEnd());
  return lines.join('\n');
}

export function renderDecision(d: PendingDecision, idx: number, total: number): string {
  const width = Math.min(process.stdout.columns ?? 80, 100) - 4;
  const indent = '             ';
  const conf = d.confidence === 'high'
    ? `${C.green}high${C.reset}`
    : d.confidence === 'medium'
    ? `${C.yellow}medium${C.reset}`
    : `${C.red}low${C.reset}`;

  const lines = [
    `${C.bold}${C.cyan}Architectural Decision ${idx + 1} of ${total}${C.reset}`,
    '─'.repeat(width),
    '',
    `  ${C.bold}${safe(d.title)}${C.reset}`,
    '',
    `  ${C.dim}ID        :${C.reset} ${safe(d.id)}`,
    `  ${C.dim}Domains   :${C.reset} ${safe(d.affectedDomains.join(', ')) || C.dim + 'unknown' + C.reset}`,
    `  ${C.dim}Confidence:${C.reset} ${conf}`,
    `  ${C.dim}Evidence  :${C.reset} ${d.verificationEvidence ?? 'legacy/unknown'}`,
    `  ${C.dim}Origin    :${C.reset} ${d.contentOrigin === 'llm-extracted' ? 'LLM-extracted' : d.contentOrigin === 'agent-recorded' ? 'agent-recorded' : 'legacy/unknown'}`,
    ...(d.contentOrigin === 'llm-extracted'
      ? [`  ${C.yellow}⚠ LLM-extracted from repository content; review every field before approval.${C.reset}`]
      : []),
    '',
    `  ${C.dim}Rationale :${C.reset} ${wrap(safe(d.rationale), width - 14, indent)}`,
  ];

  if (d.consequences) {
    lines.push(`  ${C.dim}Impact    :${C.reset} ${wrap(safe(d.consequences), width - 14, indent)}`);
  }

  if (d.proposedRequirement) {
    lines.push('');
    lines.push(`  ${C.dim}SHALL     :${C.reset} ${C.yellow}${wrap(safe(d.proposedRequirement), width - 14, indent)}${C.reset}`);
  }

  if (d.affectedFiles.length) {
    lines.push('');
    lines.push(`  ${C.dim}Files     :${C.reset} ${safe(d.affectedFiles.slice(0, 3).join(', '))}${d.affectedFiles.length > 3 ? ` +${d.affectedFiles.length - 3}` : ''}`);
  }

  lines.push('');
  lines.push('─'.repeat(width));
  lines.push(`  ${C.bold}[a]${C.reset} Approve   ${C.bold}[r]${C.reset} Reject   ${C.bold}[s]${C.reset} Skip (decide later)   ${C.bold}[q]${C.reset} Quit`);

  return lines.join('\n');
}

type Decision = 'approved' | 'rejected' | 'skipped';

export async function runTuiApproval(
  decisions: PendingDecision[],
): Promise<Map<string, Decision>> {
  const results = new Map<string, Decision>();

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return results;
  }

  const pending = decisions.filter(
    (d) => d.status === 'verified' || d.status === 'consolidated',
  );
  if (pending.length === 0) return results;

  return new Promise((resolve) => {
    let idx = 0;

    const render = () => {
      process.stdout.write(C.clear);
      process.stdout.write(renderDecision(pending[idx], idx, pending.length) + '\n');
    };

    const done = () => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      rl.close();
      process.stdout.write('\n');
      resolve(results);
    };

    const rl = readline.createInterface({ input: process.stdin, terminal: false });
    process.stdin.setRawMode(true);
    process.stdin.resume();

    render();

    process.stdin.on('data', (buf: Buffer) => {
      const key = buf.toString();

      if (key === 'q' || key === '\x03') {
        done();
        return;
      }

      const d = pending[idx];

      if (key === 'a') {
        results.set(d.id, 'approved');
      } else if (key === 'r') {
        results.set(d.id, 'rejected');
      } else if (key === 's') {
        results.set(d.id, 'skipped');
      } else {
        return;
      }

      idx++;
      if (idx >= pending.length) {
        done();
      } else {
        render();
      }
    });
  });
}
