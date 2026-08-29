import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readPreregisteredRule } from './preregistered-rule.js';

describe('pre-registered benchmark rule', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function repository(): string {
    const root = mkdtempSync(join(tmpdir(), 'openlore-bench-rule-'));
    roots.push(root);
    execFileSync('git', ['init', '--quiet'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 'bench@example.test'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 'Benchmark Test'], { cwd: root });
    execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: root });
    writeFileSync(join(root, 'rule.json'), '{"threshold":1}\n');
    execFileSync('git', ['add', 'rule.json'], { cwd: root });
    execFileSync('git', ['commit', '--quiet', '-m', 'test: register rule'], { cwd: root });
    return root;
  }

  it('rejects a staged change from the committed rule', () => {
    const root = repository();
    writeFileSync(join(root, 'rule.json'), '{"threshold":2}\n');
    execFileSync('git', ['add', 'rule.json'], { cwd: root });

    expect(() => readPreregisteredRule(root, 'rule.json'))
      .toThrow('Decision rule must be committed and unchanged before the run');
  });

  it('rejects an unstaged change from the committed rule', () => {
    const root = repository();
    writeFileSync(join(root, 'rule.json'), '{"threshold":2}\n');

    expect(() => readPreregisteredRule(root, 'rule.json'))
      .toThrow('Decision rule must be committed and unchanged before the run');
  });
});
