/**
 * An explicit --config that does not resolve must be fatal, never a silent
 * fallback to defaults (OutputContractsAreUniform, change: fix-cli-output-hygiene).
 */

import { describe, it, expect } from 'vitest';
import { checkExplicitConfig } from './config-guard.js';

describe('checkExplicitConfig', () => {
  const missing = () => false;
  const present = () => true;

  it('fails when a CLI-supplied config path is unreadable, naming the path', () => {
    const r = checkExplicitConfig('cli', '/nope/config.json', missing);
    expect(r.ok).toBe(false);
    expect(r.message).toContain('/nope/config.json');
  });

  it('passes when a CLI-supplied config path is readable', () => {
    expect(checkExplicitConfig('cli', '/exists/config.json', present).ok).toBe(true);
  });

  it('never fails on the built-in default source (pre-init repo is normal)', () => {
    expect(checkExplicitConfig('default', '.openlore/config.json', missing).ok).toBe(true);
    expect(checkExplicitConfig(undefined, '.openlore/config.json', missing).ok).toBe(true);
  });
});
