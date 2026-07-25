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
import { readFileSync, readdirSync } from 'node:fs';
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

/** Composite actions live outside `workflows/` and cannot declare `permissions`. */
const COMPOSITE_ACTIONS = [join(REPO_ROOT, '.github', 'actions', 'openlore-review', 'action.yml')];

const ALL_ACTION_FILES = [...workflowFiles.map(f => join(WORKFLOW_DIR, f)), ...COMPOSITE_ACTIONS];

const rel = (abs: string) => abs.slice(REPO_ROOT.length + 1);

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
      let runIndent: number | null = null;

      lines.forEach((line, i) => {
        const runMatch = line.match(/^(\s*)(?:-\s+)?run:\s*(.*)$/);
        if (runMatch) {
          const indent = runMatch[1].length;
          const inline = runMatch[2];
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

  it('runs CodeQL on pull requests and on a schedule', () => {
    const wf = parse(read(join(WORKFLOW_DIR, 'codeql.yml'))) as { on?: Record<string, unknown> };
    // `parse` turns the YAML key `on` into the string key 'on' (not boolean true) for
    // YAML 1.2, which is what the `yaml` package implements.
    const triggers = wf.on ?? {};
    expect(Object.keys(triggers), 'CodeQL needs both a PR trigger and a schedule').toEqual(
      expect.arrayContaining(['pull_request', 'schedule'])
    );
  });
});
