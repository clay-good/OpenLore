import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { checkEnvRenames } from './env-rename-check.js';
import { scanEnvDeclarations } from './env-declaration-scan.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@e', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@e' };
const write = (root: string, rel: string, c: string) => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), c); };
function repo(files: Record<string, string>): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'olenv-')));
  dirs.push(root);
  for (const [rel, c] of Object.entries(files)) write(root, rel, c);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root, env: GIT_ENV });
  execFileSync('git', ['add', '-A'], { cwd: root, env: GIT_ENV });
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: root, env: GIT_ENV });
  return root;
}
const MANIFESTS = {
  'docker-compose.yml': 'services:\n  api:\n    environment:\n      DATABASE_URL: x\n',
  'Dockerfile': 'FROM node\nENV DATABASE_URL=y\n',
};

describe('scanEnvDeclarations', () => {
  it('reads manifests, skips Helm templates and non-IaC JSON with a disclosure', async () => {
    const root = repo({
      ...MANIFESTS,
      'package.json': '{"name": "x"}',
      'chart/Chart.yaml': 'name: c\n',
      'chart/templates/deploy.yaml': 'kind: Deployment\nspec: {{ .Values.x }}\n',
    });
    const r = await scanEnvDeclarations(root);
    expect(r.declarations.map(d => `${d.file}:${d.line}`)).toEqual(['Dockerfile:2', 'docker-compose.yml:4']);
    expect(r.boundaries.join(' ')).toContain('Helm');
  });

  it('outside a git work tree it says so instead of returning nothing silently', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'olenv-nogit-')));
    dirs.push(root);
    const r = await scanEnvDeclarations(root);
    expect(r.boundaries[0]).toContain('not a git work tree');
  });
});

describe('checkEnvRenames', () => {
  it('a renamed read lists the manifests that still set the old name', async () => {
    const root = repo({ ...MANIFESTS, 'src/db.ts': 'export const u = process.env.DATABASE_URL;\n' });
    write(root, 'src/db.ts', 'export const u = process.env.DB_URL;\n');
    const r = await checkEnvRenames(root, 'HEAD', [{ path: 'src/db.ts', status: 'modified' }]);
    expect(r.removedReads).toEqual(['DATABASE_URL']);
    expect(r.stillSet).toEqual([{ name: 'DATABASE_URL', sites: [
      { ecosystem: 'Dockerfile', resource: 'Dockerfile', file: 'Dockerfile', line: 2 },
      { ecosystem: 'Docker Compose', resource: 'service/api', file: 'docker-compose.yml', line: 4 },
    ] }]);
  });

  it('a name still read in another file is not removed', async () => {
    const root = repo({ ...MANIFESTS, 'src/db.ts': 'export const u = process.env.DATABASE_URL;\n', 'src/other.py': 'import os\nu = os.environ["DATABASE_URL"]\n' });
    write(root, 'src/db.ts', 'export const u = 1;\n');
    const r = await checkEnvRenames(root, 'HEAD', [{ path: 'src/db.ts', status: 'modified' }]);
    expect(r.removedReads).toEqual([]);
  });

  it('a mention that is not a read (a comment, a manifest) does not keep the name alive', async () => {
    const root = repo({ ...MANIFESTS, 'src/db.ts': 'export const u = process.env.DATABASE_URL;\n', 'src/notes.ts': '// DATABASE_URL was the old name\n' });
    write(root, 'src/db.ts', 'export const u = 1;\n');
    const r = await checkEnvRenames(root, 'HEAD', [{ path: 'src/db.ts', status: 'modified' }]);
    expect(r.removedReads).toEqual(['DATABASE_URL']);
  });

  it('a deleted file counts; a diff with no code file is a no-op', async () => {
    const root = repo({ ...MANIFESTS, 'src/db.ts': 'export const u = process.env.DATABASE_URL;\n' });
    rmSync(join(root, 'src/db.ts'));
    expect((await checkEnvRenames(root, 'HEAD', [{ path: 'src/db.ts', status: 'deleted' }])).removedReads).toEqual(['DATABASE_URL']);
    expect(await checkEnvRenames(root, 'HEAD', [{ path: 'Dockerfile', status: 'modified' }])).toEqual({ removedReads: [], stillSet: [], boundaries: [] });
  });

  it('from a subdirectory, changed files outside it are not compared (no false removals)', async () => {
    const root = repo({ ...MANIFESTS, 'svc/app.ts': 'export const u = process.env.DATABASE_URL;\n', 'other/x.ts': 'export const o = process.env.OTHER_VAR;\n' });
    write(root, 'svc/app.ts', 'export const u = process.env.DB_URL;\n');
    write(root, 'other/x.ts', '// note\nexport const o = process.env.OTHER_VAR;\n');
    const r = await checkEnvRenames(join(root, 'svc'), 'HEAD', [{ path: 'other/x.ts', status: 'modified' }, { path: 'svc/app.ts', status: 'modified' }]);
    expect(r.removedReads).toEqual(['DATABASE_URL']);
  });

  it('the base side is read at the merge-base, not the base branch tip', async () => {
    const root = repo({ 'src/app.ts': 'export const a = process.env.A;\n' });
    const git = (...a: string[]) => execFileSync('git', a, { cwd: root, env: GIT_ENV });
    git('checkout', '-q', '-b', 'feat');
    write(root, 'src/app.ts', 'export const a = process.env.A;\nexport const b = 1;\n');
    git('commit', '-qam', 'feat');
    git('checkout', '-q', 'main');
    write(root, 'src/app.ts', 'export const a = process.env.A;\nexport const n = process.env.NEW_ON_MAIN;\n');
    git('commit', '-qam', 'main moves');
    git('checkout', '-q', 'feat');
    const r = await checkEnvRenames(root, 'main', [{ path: 'src/app.ts', status: 'modified' }]);
    expect(r.removedReads).toEqual([]);
  });
});
