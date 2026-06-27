#!/usr/bin/env node
/**
 * Lightweight post-install hint (change: add-zero-interaction-onboarding).
 *
 * Best practice: a postinstall must be FAST and SIDE-EFFECT-FREE. It does NOT
 * analyze, write config, or touch the user's repo — doing heavy work or
 * modifying a project on `npm install` is an anti-pattern (it runs in CI,
 * Docker builds, and as a transitive dependency). All this does is print one
 * friendly next-step so a new user knows the single command to run.
 *
 * Silent when: CI is detected, the user opted out, output is not a TTY, or
 * openlore is being installed as a transitive dependency / developed in-tree.
 * Always exits 0 — it must never fail an install.
 */

try {
  const env = process.env;
  const quiet =
    env.CI ||
    env.CONTINUOUS_INTEGRATION ||
    env.OPENLORE_SKIP_POSTINSTALL ||
    // Not an interactive install (e.g. piped, automated) — stay quiet.
    !process.stdout.isTTY;

  // Skip when openlore is a dependency of the project being installed, or when
  // developing openlore itself: in both cases INIT_CWD is not a fresh consumer.
  let isDependencyOrDev = false;
  try {
    const initCwd = env.INIT_CWD || '';
    if (initCwd) {
      const { readFileSync } = await import('node:fs');
      const { join } = await import('node:path');
      const pkg = JSON.parse(readFileSync(join(initCwd, 'package.json'), 'utf8'));
      // Developing openlore in-tree, or it appears in the consumer's deps.
      if (pkg.name === 'openlore') isDependencyOrDev = true;
    }
  } catch {
    /* no package.json at INIT_CWD → a global/standalone install; show the hint */
  }

  if (!quiet && !isDependencyOrDev) {
    const b = (s) => `\x1b[1m${s}\x1b[0m`;
    const dim = (s) => `\x1b[2m${s}\x1b[0m`;
    process.stdout.write(
      `\n${b('OpenLore')} installed. One command wires your coding agent and builds the index:\n\n` +
        `  ${b('cd your-project && openlore install')}\n\n` +
        `${dim('It auto-detects your agent (Claude Code, Cursor, Cline, …), needs no API key,')}\n` +
        `${dim('and builds a local structural index. Then just code — your agent calls orient().')}\n\n`
    );
  }
} catch {
  /* never fail an install */
}

process.exit(0);
