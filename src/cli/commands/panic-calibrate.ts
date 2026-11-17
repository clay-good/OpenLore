/**
 * openlore panic-calibrate
 *
 * Measure the panic signal's accuracy against the labeled ground-truth corpus by replaying each
 * scenario through the real engine. Reports the false-positive rate, sensitivity (true-positive
 * rate), and the documented known-sensitivities (where the signal is weak). This is the in-code
 * accuracy evidence the observe-mode gate needs — complementary to real observe-mode telemetry.
 *
 * Read-only. Exits 0 by default; --strict exits 1 if discrimination on the clear-cut corpus
 * regresses (any false positive, or sensitivity below 100%).
 */

import { Command } from 'commander';
import { computeCalibration, evaluateSensitivities } from '../../core/services/mcp-handlers/panic-calibration.js';
import { jsonOutput } from '../output.js';

export const panicCalibrateCommand = new Command('panic-calibrate')
  .description('Measure panic-signal accuracy against the labeled ground-truth corpus (read-only)')
  .option('--json', 'Emit the calibration report as JSON', false)
  .option('--strict', 'Exit 1 if discrimination on the clear-cut corpus regresses', false)
  .action((options: { json: boolean; strict: boolean }) => {
    let exitCode = 0;
    try {
      const report = computeCalibration();
      const sensitivities = evaluateSensitivities();

      if (options.json) {
        process.stdout.write(jsonOutput({ ...report, known_sensitivities: sensitivities }) + '\n');
      } else {
        const L: string[] = [];
        L.push('PANIC SIGNAL CALIBRATION — accuracy vs. labeled ground truth');
        L.push('────────────────────────────────────────────────────────────');
        for (const s of report.scenarios) {
          L.push(`  ${s.correct ? '✓' : '✗'} ${s.label.padEnd(9)} ${s.name.padEnd(32)} peakL=${s.peakLevel}  trippedL2=${s.trippedL2}`);
        }
        L.push('');
        L.push(`  false-positive rate : ${(report.false_positive_rate * 100).toFixed(0)}%  (${report.false_positives}/${report.coherent_total} coherent traces tripped)`);
        L.push(`  sensitivity (TP)    : ${(report.true_positive_rate * 100).toFixed(0)}%  (${report.true_positives}/${report.confused_total} confused traces tripped)`);
        L.push(`  accuracy            : ${(report.accuracy * 100).toFixed(0)}%`);
        if (sensitivities.length) {
          L.push('');
          L.push('  KNOWN SENSITIVITIES (documented, not asserted — the gate must weigh these):');
          for (const s of sensitivities) {
            L.push(`    • ${s.name} — trips L2+ today: ${s.trippedL2}`);
            L.push(`      ${s.note}`);
          }
        }
        L.push('');
        L.push('  Note: this is a labeled-corpus baseline, not a substitute for real observe-mode');
        L.push('  telemetry. Validate on real sessions with `openlore panic-validate` before enabling');
        L.push('  any interventional posture by default.');
        process.stdout.write(L.join('\n') + '\n');
      }

      if (options.strict) {
        const regressed = report.false_positives > 0 || report.true_positive_rate < 1
          || sensitivities.some((s) => !s.matchesDocumented);
        exitCode = regressed ? 1 : 0;
      }
    } catch {
      if (options.strict) exitCode = 1;
    }
    process.exit(exitCode);
  });
