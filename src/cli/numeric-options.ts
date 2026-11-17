/**
 * Commander coercers that REFUSE nonsense instead of passing it on
 * (change: fix-cli-input-validation).
 *
 * `parseInt('abc', 10)` is `NaN`, and `NaN` is not nullish — so a handler's `opts.max ?? DEFAULT`
 * never fires, `NaN` flows into a slice bound, and the command answers with an EMPTY list and
 * exit 0. `openlore certify-public-surface --max abc` reported an empty public API surface for a
 * repository that exports seven symbols; a consumer in CI would act on that. A zero or negative
 * bound skipped the default the same way and was silently clamped to 1.
 *
 * Commander treats a throw from a coercer as a usage error: it prints the message and exits
 * non-zero, which is what `openlore search --limit abc` already did through its own validator.
 * These are that validator, shared, so a flag cannot be added without one.
 */

import { InvalidArgumentError } from 'commander';

/** A bound that must be a whole number ≥ 1 (`--max`, `--limit`). */
export function positiveIntegerOption(option: string): (value: string) => number {
  return (value: string) => {
    const n = Number(value);
    if (!Number.isInteger(n) || n < 1) {
      throw new InvalidArgumentError(`${option} must be a positive integer.`);
    }
    return n;
  };
}

/** A depth bound that must be a whole number ≥ 1 (`--max-depth`); 0 would traverse nothing. */
export function depthOption(option: string): (value: string) => number {
  return positiveIntegerOption(option);
}

/** A similarity ratio that must fall inside its documented range (`--min`). */
export function ratioOption(option: string, min: number, max: number): (value: string) => number {
  return (value: string) => {
    const n = Number(value);
    if (!Number.isFinite(n) || n < min || n > max) {
      throw new InvalidArgumentError(`${option} must be a number between ${min} and ${max}.`);
    }
    return n;
  };
}
