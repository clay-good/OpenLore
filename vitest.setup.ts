/**
 * Global test setup.
 *
 * Pins the USER-scope install root (`OPENLORE_HOME`) to a throwaway directory for
 * every test file. Bare `openlore install` now writes a per-user footprint —
 * `~/.claude.json`, `~/.claude/settings.json`, `~/.claude/CLAUDE.md` — and without
 * this pin any test that calls `runInstall` edits the *developer's own* agent
 * configuration. That is not hypothetical: the first draft of
 * `unify-onboarding-entrypoint` did exactly that, silently, and the suite stayed
 * green.
 *
 * `resolveUserScopeRoot` refuses to fall back to the real home under a test runner,
 * so this file is the one place that decides where a test's user scope goes. A test
 * that needs its own directory passes `home` to `runInstall` explicitly.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const sandboxHome = mkdtempSync(join(tmpdir(), 'openlore-test-home-'));
process.env.OPENLORE_HOME = sandboxHome;

process.on('exit', () => {
  try {
    rmSync(sandboxHome, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup; a leftover temp directory is not worth failing a run.
  }
});
