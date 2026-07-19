/**
 * Shared color layer for CLI command modules.
 *
 * Every command that colorizes inline text (status glyphs, badges, confidence
 * markers) routes through here instead of embedding raw `\x1b[…m` escape codes.
 * Raw escapes ignore both `--no-color` and non-TTY streams, so they pollute
 * pipes and CI logs (OutputContractsAreUniform, change: fix-cli-output-hygiene).
 *
 * The decision is centralized: color is emitted only when the global logger is
 * not in `--no-color` mode AND the target stream is a color-capable TTY (chalk's
 * own detection, which also honors the `NO_COLOR` / `FORCE_COLOR` env vars).
 */

import chalk, { Chalk, chalkStderr, type ChalkInstance } from 'chalk';
import { logger } from './logger.js';

/** A chalk instance with color forced off — every style method returns its input unchanged. */
const plain = new Chalk({ level: 0 });

/**
 * Color helpers for stdout. Returns a chalk instance that respects `--no-color`
 * (the global logger flag) and, when color is otherwise allowed, chalk's own
 * TTY / NO_COLOR detection for stdout.
 */
export function colorForStdout(): ChalkInstance {
  return logger.getOptions().noColor ? plain : chalk;
}

/** Color helpers for stderr, keyed off stderr's own TTY state. */
export function colorForStderr(): ChalkInstance {
  return logger.getOptions().noColor ? plain : chalkStderr;
}

/**
 * Pick between the live chalk instance and a plain one from a caller-computed
 * decision (e.g. a command that also disables color in `--json` mode).
 */
export function palette(useColor: boolean): ChalkInstance {
  return useColor ? chalk : plain;
}
