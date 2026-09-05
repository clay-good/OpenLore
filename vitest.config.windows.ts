/**
 * Windows unit-test configuration (issue #434).
 *
 * Identical to the base config except that it drops the test files listed in
 * `.github/windows-unit-exclusions.json`. Before this, exactly ONE test file ran on Windows in CI
 * (`pi-surface.test.ts`), so 480 of 481 files — including every path, filesystem and subprocess
 * suite, the places where a Windows-only defect actually lives — were never exercised on the
 * platform. This config is what lets the rest run.
 *
 * The list is a deny-list, deliberately, so the default for a NEW test file is to run on Windows.
 * An allow-list would silently leave every future file uncovered, which is the failure mode that
 * produced #434 in the first place.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { defineConfig, mergeConfig } from 'vitest/config';
import base from './vitest.config.js';

const HERE = dirname(fileURLToPath(import.meta.url));

export interface WindowsUnitExclusion {
  file: string;
  failingTests: number;
  reason: string;
  suspectedProductionBug?: boolean;
}

/** The deny-list, read from the single source of truth the CI guard also reads. */
export function windowsUnitExclusions(root = HERE): WindowsUnitExclusion[] {
  const raw = readFileSync(join(root, '.github', 'windows-unit-exclusions.json'), 'utf-8');
  return (JSON.parse(raw) as { exclusions: WindowsUnitExclusion[] }).exclusions;
}

export default mergeConfig(
  base,
  defineConfig({
    test: {
      // Appended to the base config's own exclusions (integration tests, node_modules) rather than
      // replacing them — `mergeConfig` concatenates arrays.
      exclude: windowsUnitExclusions().map((entry) => entry.file),
    },
  }),
);
