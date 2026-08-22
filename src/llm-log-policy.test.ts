/**
 * LLM persistence policy guard
 * (change: harden-llm-log-and-telemetry-honesty).
 *
 * OpenLore's own CLI/API paths must never turn source-bearing request logs on
 * unconditionally. Explicit LLMService consumers and tests may still opt in.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { globSync } from 'glob';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('OpenLore-owned LLM logging is explicit opt-in', () => {
  it('has no unconditional production enableLogging call site', () => {
    const files = globSync('src/{api,cli}/**/*.ts', {
      cwd: REPO_ROOT,
      ignore: ['**/*.test.ts'],
      nodir: true,
    });
    const offenders = files.filter(file => /enableLogging\s*:\s*true\b/.test(
      readFileSync(join(REPO_ROOT, file), 'utf8'),
    ));
    expect(offenders, 'source-bearing LLM logs must require OPENLORE_LLM_LOGS=1').toEqual([]);

    const ownedCallers = files.filter(file => /enableLogging\s*:\s*isLlmLoggingEnabled\(\)/.test(
      readFileSync(join(REPO_ROOT, file), 'utf8'),
    ));
    expect(ownedCallers).toHaveLength(11);
    expect(ownedCallers.filter(file => !/\blogRoot\s*:/.test(
      readFileSync(join(REPO_ROOT, file), 'utf8'),
    )), 'each OpenLore-owned caller must confine its repository-derived log path').toEqual([]);
  });

  it('discloses LLM-log persistence and every telemetry content domain', () => {
    const readme = readFileSync(join(REPO_ROOT, 'README.md'), 'utf8');
    const normalized = readme.toLowerCase().replace(/\s+/g, ' ');
    expect(readme).toContain('OPENLORE_LLM_LOGS=1');
    expect(readme).toContain('.openlore/logs/');
    const configuration = readFileSync(join(REPO_ROOT, 'docs/configuration.md'), 'utf8');
    expect(configuration).toContain('`OPENLORE_LLM_LOGS`');
    expect(configuration).toContain('exactly `1`');
    for (const disclosure of [
      'prompts and responses',
      'tool calls',
      'agent identity',
      'latency',
      'error messages',
      'decision titles',
      'lease events',
    ]) {
      expect(normalized, `README must disclose ${disclosure}`).toContain(disclosure);
    }
  });
});
