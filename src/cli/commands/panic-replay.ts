/**
 * openlore panic-replay <trace.jsonl>
 *
 * Replay a recorded/synthetic behavioral trace through the REAL panic engine and print the panic
 * timeline + summary. Deterministic (virtual clock), read-only. This is how a maintainer validates
 * the signal against a specific real session: capture the tool sequence, replay it, see whether —
 * and where — it would have tripped an intervention.
 *
 * Trace format: JSON Lines, one step per line: {"tool":"search_code","filePath":"src/auth/x.ts","gapMs":15000}
 *   - tool:     required (drives cognitive-load weight + the module window)
 *   - filePath: optional (drives module/density/oscillation; omit for non-file tools)
 *   - gapMs:    optional ms since the previous step (drives decay/staleness); default 0
 */

import { Command } from 'commander';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { replayBehavioralTrace, type ReplayStep } from '../../core/services/mcp-handlers/panic-replay.js';
import { jsonOutput } from '../output.js';

function readTrace(path: string): ReplayStep[] {
  const steps: ReplayStep[] = [];
  for (const line of readFileSync(path, 'utf-8').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const o = JSON.parse(t) as Record<string, unknown>;
      if (!o || typeof o.tool !== 'string') continue; // a step needs a tool name
      // Sanitize: a non-string filePath / non-number gapMs is dropped, not crashed on.
      const step: ReplayStep = { tool: o.tool };
      if (typeof o.filePath === 'string') step.filePath = o.filePath;
      if (typeof o.gapMs === 'number' && Number.isFinite(o.gapMs)) step.gapMs = o.gapMs;
      steps.push(step);
    } catch { /* skip malformed line */ }
  }
  return steps;
}

export const panicReplayCommand = new Command('panic-replay')
  .description('Replay a behavioral trace (JSONL) through the panic engine — panic timeline (read-only)')
  .argument('<trace>', 'Path to a JSONL trace file ({tool, filePath?, gapMs?} per line)')
  .option('--sourceRoots <list>', 'Comma-separated source roots for module derivation', 'src')
  .option('--json', 'Emit the full replay result as JSON', false)
  .option('--timeline', 'Print the per-step timeline (human mode)', false)
  .action((trace: string, options: { sourceRoots: string; json: boolean; timeline: boolean }) => {
    try {
      if (!existsSync(trace) || !statSync(trace).isFile()) {
        process.stderr.write(`panic-replay: not a readable trace file: ${trace}\n`);
        process.exit(1);
      }
      const steps = readTrace(trace);
      const sourceRoots = options.sourceRoots.split(',').map((s) => s.trim()).filter(Boolean);
      const result = replayBehavioralTrace(steps, { sourceRoots });

      if (options.json) {
        process.stdout.write(jsonOutput(result) + '\n');
      } else {
        const L: string[] = [];
        L.push(`PANIC REPLAY — ${steps.length} steps`);
        L.push('────────────────────────────────────────');
        L.push(`peak level   : L${result.peakLevel}  (score ${result.peakScore})`);
        L.push(`tripped L2+  : ${result.trippedL2}`);
        L.push(`final        : L${result.finalLevel}, freshness=${result.finalState}`);
        if (options.timeline) {
          L.push('');
          for (const t of result.timeline) {
            L.push(`  ${String(t.i).padStart(3)}  ${t.tool.padEnd(22)} L${t.panicLevel} score=${String(t.panicScore).padStart(3)}  density=${t.density} osc=${t.oscillation} ${t.freshnessState}`);
          }
        }
        process.stdout.write(L.join('\n') + '\n');
      }
    } catch (e) {
      process.stderr.write(`panic-replay: ${e instanceof Error ? e.message : String(e)}\n`);
      process.exit(1);
    }
    process.exit(0);
  });
