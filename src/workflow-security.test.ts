/**
 * CI/CD workflow hardening guards.
 *
 * The hardening in `.github/` is configuration, and configuration decays: a new
 * workflow gets copied from a blog post with `@v4` and no `permissions:` block, a
 * `${{ }}` gets inlined into a `run:` script because it reads more naturally, a SHA
 * pin loses its version comment and becomes un-reviewable. None of that fails a
 * build, and none of it shows up in a diff as obviously wrong.
 *
 * These guards follow the same discipline as `doc-claim-sync.test.ts`: bind the
 * published posture to a check, so weakening it requires editing this file in the
 * same reviewed change.
 *
 * Guarded:
 *   1. Third-party actions are pinned to a full commit SHA (a tag is a moving pointer).
 *   2. Each pin carries a `# vX.Y.Z` comment, so a human can tell what a SHA is.
 *   3. `run:` scripts take untrusted values through `env:`, never inline `${{ }}`.
 *   4. Every executed workflow declares a top-level `permissions` block.
 *   5. Every job declares its own `permissions` block.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parse } from 'yaml';

// src/<this> → repo root is one level up.
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WORKFLOW_DIR = join(REPO_ROOT, '.github', 'workflows');

const read = (abs: string) => readFileSync(abs, 'utf-8');

/**
 * Executed workflows only. `*.yml.example` is documentation a user copies — pinning
 * SHAs there would create pins that go stale silently, because Dependabot does not
 * scan `.example` files. Teaching the pattern is the example's job; being correct
 * right now is these files' job.
 */
const workflowFiles = readdirSync(WORKFLOW_DIR)
  .filter(f => f.endsWith('.yml') || f.endsWith('.yaml'))
  .sort();

/**
 * Composite actions live outside `workflows/` and cannot declare `permissions`.
 *
 * DISCOVERED, never listed. A hardcoded path only guards the actions that existed when
 * the list was written: adding a second composite action would silently escape the
 * pinning, version-comment, and Dependabot-coverage checks below — the exact drift
 * these guards exist to catch, and a guard that quietly under-covers is worse than no
 * guard, because the green check implies coverage it does not have.
 */
function findActionManifests(dir: string): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return []; // directory absent is fine — nothing to guard
  }
  return entries.flatMap(e => {
    const full = join(dir, e.name);
    if (e.isDirectory()) return findActionManifests(full);
    return e.name === 'action.yml' || e.name === 'action.yaml' ? [full] : [];
  });
}

const COMPOSITE_ACTIONS = [
  ...findActionManifests(join(REPO_ROOT, '.github', 'actions')),
  // A repo can also publish a single action from its root. Checked directly rather than
  // by walking from REPO_ROOT, which would descend into node_modules.
  ...['action.yml', 'action.yaml'].map(f => join(REPO_ROOT, f)).filter(existsSync),
].sort();

const ALL_ACTION_FILES = [...workflowFiles.map(f => join(WORKFLOW_DIR, f)), ...COMPOSITE_ACTIONS];

const rel = (abs: string) => abs.slice(REPO_ROOT.length + 1);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return entry.name.endsWith('.ts') && !entry.name.includes('.test.') && !entry.name.includes('.spec.')
      ? [full]
      : [];
  });
}

/**
 * The only expressions allowed to be interpolated directly into a `run:` script.
 * `needs.<job>.result` is a closed enum produced by Actions itself
 * ('success' | 'failure' | 'cancelled' | 'skipped') — it cannot carry an attacker's
 * shell metacharacters. Everything else must arrive via `env:`, where quoting makes
 * it inert data rather than program text.
 */
const SAFE_IN_RUN = [/^needs\.[A-Za-z0-9_-]+\.result$/];

describe('workflow security: action pinning', () => {
  it('pins every third-party action to a full commit SHA', () => {
    const offenders: string[] = [];

    for (const file of ALL_ACTION_FILES) {
      const lines = read(file).split('\n');
      lines.forEach((line, i) => {
        const m = line.match(/^\s*(?:-\s+)?uses:\s*(\S+)/);
        if (!m) return;
        const ref = m[1].replace(/['"]/g, '');
        // Local composite actions (`./.github/actions/...`) are this repo's own code,
        // already governed by the commit under review.
        if (ref.startsWith('./')) return;
        const at = ref.lastIndexOf('@');
        if (at === -1) {
          offenders.push(`${rel(file)}:${i + 1} — no version ref at all: ${ref}`);
          return;
        }
        const version = ref.slice(at + 1);
        if (!/^[0-9a-f]{40}$/.test(version)) {
          offenders.push(
            `${rel(file)}:${i + 1} — pinned to the moving ref "${version}"; use a 40-char commit SHA`
          );
        }
      });
    }

    expect(
      offenders,
      `Actions must be pinned to an immutable commit SHA. A tag can be re-pointed at new code by ` +
        `whoever controls the action repo, and it then runs with this workflow's token.\n` +
        `Resolve with: gh api repos/<owner>/<repo>/git/ref/tags/<tag> -q .object.sha\n\n` +
        offenders.join('\n')
    ).toEqual([]);
  });

  it('annotates every SHA pin with the human-readable version', () => {
    const offenders: string[] = [];

    for (const file of ALL_ACTION_FILES) {
      const lines = read(file).split('\n');
      lines.forEach((line, i) => {
        const m = line.match(/^\s*(?:-\s+)?uses:\s*(\S+)/);
        if (!m) return;
        const ref = m[1].replace(/['"]/g, '');
        if (ref.startsWith('./')) return;
        if (!/@[0-9a-f]{40}$/.test(ref)) return; // pinning itself is the other test's job
        // Expect a trailing `# vX.Y.Z` (what Dependabot writes and updates).
        if (!/#\s*v?\d+\.\d+(\.\d+)?/.test(line)) {
          offenders.push(`${rel(file)}:${i + 1} — SHA pin without a "# vX.Y.Z" comment`);
        }
      });
    }

    expect(
      offenders,
      `A bare SHA is unreviewable and unupgradable by hand. Keep the trailing version comment ` +
        `(Dependabot maintains it):\n  uses: actions/checkout@<sha> # v6.1.0\n\n` + offenders.join('\n')
    ).toEqual([]);
  });
});

describe('workflow security: no shell injection via run:', () => {
  it('passes untrusted values through env:, not inline ${{ }}', () => {
    const offenders: string[] = [];

    for (const file of ALL_ACTION_FILES) {
      const text = read(file);
      const lines = text.split('\n');

      // Track whether the current line is inside a `run:` block by indentation: a
      // `run: |` opens one, and it ends at the first line indented no deeper than the
      // `run:` key itself. Parsing the YAML instead would lose the line numbers that
      // make a failure actionable.
      //
      // The column that matters is where the `run` KEY starts, not where the line's
      // whitespace ends. In the list-item form (`- run: |`) the `- ` shifts the key
      // right, and sibling keys of that step (`env:`, `shell:`) align with the key
      // rather than with the dash. Measuring from the dash would put those siblings
      // "inside" the block and flag `env: ${{ ... }}` — the very pattern this guard
      // exists to encourage.
      let runIndent: number | null = null;

      lines.forEach((line, i) => {
        const runMatch = line.match(/^(\s*)(-\s+)?run:\s*(.*)$/);
        if (runMatch) {
          const indent = runMatch[1].length + (runMatch[2]?.length ?? 0);
          const inline = runMatch[3];
          // Single-line `run: cmd` — check it right here, no block to track.
          if (inline && !/^[|>]/.test(inline.trim())) {
            for (const expr of inline.matchAll(/\$\{\{\s*([^}]+?)\s*\}\}/g)) {
              const body = expr[1].trim();
              if (!SAFE_IN_RUN.some(re => re.test(body))) {
                offenders.push(`${rel(file)}:${i + 1} — inline \${{ ${body} }} in a run: command`);
              }
            }
            runIndent = null;
            return;
          }
          runIndent = indent;
          return;
        }

        if (runIndent === null) return;
        if (line.trim() === '') return;
        const indent = line.match(/^(\s*)/)![1].length;
        if (indent <= runIndent) {
          runIndent = null; // block ended
          return;
        }
        for (const expr of line.matchAll(/\$\{\{\s*([^}]+?)\s*\}\}/g)) {
          const body = expr[1].trim();
          if (!SAFE_IN_RUN.some(re => re.test(body))) {
            offenders.push(`${rel(file)}:${i + 1} — inline \${{ ${body} }} inside a run: block`);
          }
        }
      });
    }

    expect(
      offenders,
      `Actions expressions are substituted into the script TEXT before bash parses it, so an ` +
        `inline \${{ }} is program, not an argument — a shell metacharacter in the value is ` +
        `executed rather than compared.\n` +
        `Pass it via env: and quote it instead:\n` +
        `    env:\n      MY_VALUE: \${{ inputs.thing }}\n    run: echo "$MY_VALUE"\n\n` +
        offenders.join('\n')
    ).toEqual([]);
  });
});

describe('workflow security: least-privilege tokens', () => {
  it('declares a top-level permissions block in every workflow', () => {
    const offenders: string[] = [];

    for (const name of workflowFiles) {
      const doc = parse(read(join(WORKFLOW_DIR, name))) as Record<string, unknown> | null;
      if (!doc || doc.permissions === undefined) {
        offenders.push(`.github/workflows/${name} — no top-level "permissions:"`);
      }
    }

    expect(
      offenders,
      `Without an explicit block, a workflow inherits the repo-wide default token scope — a ` +
        `setting that lives outside this file and can be widened without touching it. State the ` +
        `floor in the workflow (usually "permissions:\\n  contents: read").\n\n` + offenders.join('\n')
    ).toEqual([]);
  });

  it('declares permissions on every job', () => {
    const offenders: string[] = [];

    for (const name of workflowFiles) {
      const doc = parse(read(join(WORKFLOW_DIR, name))) as { jobs?: Record<string, unknown> } | null;
      const jobs = doc?.jobs ?? {};
      for (const [jobName, job] of Object.entries(jobs)) {
        const j = job as Record<string, unknown> | null;
        if (!j || j.permissions === undefined) {
          offenders.push(`.github/workflows/${name} → job "${jobName}" — no "permissions:"`);
        }
      }
    }

    expect(
      offenders,
      `Each job should state the scope it needs, so widening one job (e.g. adding ` +
        `"contents: write" to publish a release) is visible in review and does not silently ` +
        `apply to the others.\n\n` + offenders.join('\n')
    ).toEqual([]);
  });
});

describe('workflow security: supply-chain automation is wired', () => {
  it('keeps Dependabot watching both npm and github-actions', () => {
    const cfg = parse(read(join(REPO_ROOT, '.github', 'dependabot.yml'))) as {
      updates?: { 'package-ecosystem'?: string }[];
    };
    const ecosystems = (cfg.updates ?? []).map(u => u['package-ecosystem']);

    // The github-actions entry is what keeps SHA pins from freezing on a stale,
    // eventually-vulnerable version — pinning without an upgrade path is its own risk.
    expect(ecosystems, 'dependabot.yml must cover npm and github-actions').toEqual(
      expect.arrayContaining(['npm', 'github-actions'])
    );
  });

  it('watches every directory that references a third-party action', () => {
    const cfg = parse(read(join(REPO_ROOT, '.github', 'dependabot.yml'))) as {
      updates?: { 'package-ecosystem'?: string; directory?: string; directories?: string[] }[];
    };

    // Normalize to a set of watched directories, minus trailing slashes.
    const watched = new Set(
      (cfg.updates ?? [])
        .filter(u => u['package-ecosystem'] === 'github-actions')
        .flatMap(u => u.directories ?? [u.directory ?? '/'])
        .map(d => (d === '/' ? '/' : d.replace(/\/$/, '')))
    );

    // A `directory: /` entry covers `.github/workflows` and nothing else. A composite
    // action lives in its own directory and needs its own entry, or its SHA pins are
    // frozen with nothing proposing upgrades. This is how the composite action went
    // unmonitored initially — the config looked complete because the workflows were.
    const offenders: string[] = [];
    for (const file of COMPOSITE_ACTIONS) {
      const hasThirdParty = read(file)
        .split('\n')
        .some(l => {
          const m = l.match(/^\s*(?:-\s+)?uses:\s*(\S+)/);
          return !!m && !m[1].replace(/['"]/g, '').startsWith('./');
        });
      if (!hasThirdParty) continue;
      const dir = '/' + rel(dirname(file)).replace(/\\/g, '/');
      if (!watched.has(dir)) offenders.push(`${dir} (from ${rel(file)})`);
    }

    expect(
      offenders,
      `These directories reference third-party actions but no github-actions Dependabot ` +
        `entry watches them, so their pins will never be proposed for upgrade. Add to ` +
        `.github/dependabot.yml:\n` +
        offenders.map(d => `  - package-ecosystem: github-actions\n    directory: ${d.split(' ')[0]}`).join('\n') +
        '\n'
    ).toEqual([]);
  });

  it('runs CodeQL on pull requests and on a schedule', () => {
    const wf = parse(read(join(WORKFLOW_DIR, 'codeql.yml'))) as { on?: Record<string, unknown> };
    // `parse` turns the YAML key `on` into the string key 'on' (not boolean true) for
    // YAML 1.2, which is what the `yaml` package implements.
    const triggers = wf.on ?? {};
    expect(Object.keys(triggers), 'CodeQL needs both a PR trigger and a schedule').toEqual(
      expect.arrayContaining(['pull_request', 'schedule'])
    );
  });

  it('builds the release outside the minimal OIDC publishing job', () => {
    const workflow = parse(read(join(WORKFLOW_DIR, 'release.yml'))) as {
      jobs: Record<string, {
        permissions?: Record<string, string>;
        steps?: { uses?: string; run?: string }[];
      }>;
    };
    const validate = workflow.jobs.validate;
    const publish = workflow.jobs.publish;
    const validateRuns = (validate.steps ?? []).map(step => step.run ?? '').join('\n');
    const publishRuns = (publish.steps ?? []).map(step => step.run ?? '').join('\n');
    const publishActions = (publish.steps ?? []).map(step => step.uses ?? '').filter(Boolean);

    expect(validate.permissions?.['id-token']).toBeUndefined();
    expect(validateRuns).toContain('git merge-base --is-ancestor');
    expect(validateRuns).toContain('npm run audit:gate');
    expect(validateRuns).toContain('npm pack --json');

    expect(publish.permissions?.['id-token']).toBe('write');
    expect(publishActions.some(action => action.startsWith('actions/checkout@'))).toBe(false);
    expect(publishActions.some(action => action.startsWith('actions/download-artifact@'))).toBe(true);
    expect(publishRuns).toContain('sha256sum --check');
    expect(publishRuns).toContain('npm publish');
    expect(publishRuns).toContain('--ignore-scripts');
    expect(publishRuns).not.toMatch(/npm (ci|install|run|pack)\b/);
  });

  it('builds the SHA-pinned Action checkout with its locked dependencies and isolated npm config', () => {
    const action = parse(read(join(REPO_ROOT, '.github', 'actions', 'openlore-review', 'action.yml'))) as {
      inputs: Record<string, { required?: boolean; default?: string }>;
      runs: { steps?: { run?: string; env?: Record<string, string> }[] };
    };
    const build = (action.runs.steps ?? []).find(step => step.run?.includes('npm ci'));
    const allRuns = (action.runs.steps ?? []).map(step => step.run ?? '').join('\n');

    expect(action.inputs['openlore-version']).toBeUndefined();
    expect(build?.env?.ACTION_PATH).toBe('${{ github.action_path }}');
    expect(build?.run).toContain('ACTION_PATH/../../..');
    expect(build?.run).toContain('package-lock.json');
    expect(build?.run).toContain('npm ci --ignore-scripts');
    expect(build?.run).toContain('npm run build');
    expect(build?.run).toContain('dist/cli/index.js');
    expect(build?.env?.NPM_CONFIG_REGISTRY).toBe('https://registry.npmjs.org/');
    expect(build?.env?.NPM_CONFIG_IGNORE_SCRIPTS).toBe('true');
    expect(build?.env?.NPM_CONFIG_USERCONFIG).toContain('runner.temp');
    expect(build?.env?.NPM_CONFIG_GLOBALCONFIG).toContain('runner.temp');
    expect(allRuns).not.toContain('npm install');
    expect(allRuns).not.toContain('npx ');
  });

  it('pins every registry tarball to an integrity digest', () => {
    const lock = JSON.parse(read(join(REPO_ROOT, 'package-lock.json'))) as {
      packages?: Record<string, { resolved?: string; integrity?: string }>;
    };
    const missing = Object.entries(lock.packages ?? {})
      .filter(([, pkg]) => pkg.resolved?.startsWith('https://registry.npmjs.org/') && !pkg.integrity)
      .map(([path]) => path);

    expect(
      missing,
      'Every registry tarball must have an SRI digest so npm ci verifies the locked bytes.'
    ).toEqual([]);
  });
});

describe('workflow security: reviewed CodeQL egress stays narrow and auditable', () => {
  it('allows only the fifteen reviewed file-to-HTTP egress sinks', () => {
    const markers: Record<string, number> = {};
    const unexplained: string[] = [];

    for (const file of sourceFiles(join(REPO_ROOT, 'src'))) {
      const lines = read(file).split('\n');
      lines.forEach((line, index) => {
        if (!line.includes('codeql[')) return;
        const location = `${rel(file)}:${index + 1}`;
        if (line.trim() !== '// codeql[js/file-access-to-http]' ||
            lines[index - 1]?.trim().startsWith('// INTENTIONAL EGRESS:') !== true) {
          unexplained.push(location);
        }
        markers[rel(file)] = (markers[rel(file)] ?? 0) + 1;
      });
    }

    expect(
      unexplained,
      'Every reviewed CodeQL egress marker must name one query and have an immediately preceding rationale.'
    ).toEqual([]);
    expect(markers, 'Changing the reviewed egress set requires explicit security review.').toEqual({
      'src/api/health.ts': 1,
      'src/cli/commands/doctor.ts': 1,
      'src/cli/commands/serve.ts': 2,
      'src/cli/commands/view.ts': 1,
      'src/core/analyzer/embedding-service.ts': 1,
      'src/core/services/chat-agent.ts': 4,
      'src/core/services/serve-client.ts': 1,
      'src/core/services/llm-service.ts': 4,
      'src/pi/extension.ts': 1,
    });
  });
});
