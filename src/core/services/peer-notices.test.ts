import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { handleDeclareFootprint } from './mcp-handlers/declare-footprint.js';
import { peerChangeNotices } from './peer-notices.js';
import { boardDir, readBoard } from './footprint-board.js';
import { runHook } from '../../cli/commands/hook.js';
import { OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR, ARTIFACT_LLM_CONTEXT } from '../../constants.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@e', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@e' };
const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, env: GIT_ENV }).toString().trim();
const write = (root: string, rel: string, c: string) => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), c); };

const CONFIG_TS = 'export function parseConfig(s: string) {\n  return JSON.parse(s);\n}\nexport function loadConfig() {\n  return parseConfig("{}");\n}\n';
const nodes = [
  { id: 'src/config.ts::parseConfig', name: 'parseConfig', filePath: 'src/config.ts', startIndex: 0, endIndex: 63, startLine: 1, endLine: 3, language: 'TypeScript' },
  { id: 'src/config.ts::loadConfig', name: 'loadConfig', filePath: 'src/config.ts', startIndex: 64, endIndex: 122, startLine: 4, endLine: 6, language: 'TypeScript' },
];
const index = (root: string) => write(root, join(OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR, ARTIFACT_LLM_CONTEXT), JSON.stringify({ callGraph: { nodes, edges: [] } }));

/** A clone on main (worktree A, agent reading parseConfig) and a sibling worktree B on feat-b. */
function clone(): { a: string; b: string } {
  const a = realpathSync(mkdtempSync(join(tmpdir(), 'olnotice-')));
  dirs.push(a);
  write(a, '.gitignore', '.openlore/\n');
  write(a, 'src/config.ts', CONFIG_TS);
  write(a, 'src/other.ts', 'export const x = 1;\n');
  git(a, 'init', '-q', '-b', 'main');
  git(a, 'add', '-A');
  git(a, 'commit', '-qm', 'init');
  git(a, 'checkout', '-q', '-b', 'feat-a');
  const b = `${a}-b`;
  dirs.push(b);
  git(a, 'worktree', 'add', '-q', '-b', 'feat-b', b, 'main');
  index(a);
  index(b);
  return { a, b };
}

const afterEdit = async (root: string, file: string) => {
  const out = (await runHook('after-tools', JSON.stringify({ session_id: 's1', cwd: root, tool_name: 'Edit', tool_input: { file_path: join(root, file) } }))).stdout;
  return out ? (JSON.parse(out) as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput.additionalContext : '';
};

describe('peer change notices', () => {
  it('a peer editing a symbol I declared reading is named in my next after-tools receipt', async () => {
    const { a, b } = clone();
    await handleDeclareFootprint({ directory: a, actorId: 'agent-a', readSet: ['parseConfig'], writeSet: ['src/other.ts'] });
    await handleDeclareFootprint({ directory: b, actorId: 'agent-b', writeSet: ['parseConfig'] });
    write(b, 'src/config.ts', CONFIG_TS.replace('JSON.parse(s)', 'JSON.parse(s.trim())'));
    const notices = await peerChangeNotices(a);
    expect(notices).toEqual([expect.objectContaining({ symbol: 'parseConfig', file: 'src/config.ts', peer: expect.objectContaining({ actorId: 'agent-b', branch: 'feat-b' }) })]);
    const text = await afterEdit(a, 'src/other.ts');
    expect(text).toContain('Peer agent-b (feat-b');
    expect(text).toContain('changed parseConfig (src/config.ts), which an agent in this worktree declared reading');
    // Stated once per session.
    expect(await afterEdit(a, 'src/other.ts')).not.toContain('changed parseConfig');
  });

  it('a peer editing a symbol I did not declare reading is quiet', async () => {
    const { a, b } = clone();
    await handleDeclareFootprint({ directory: a, actorId: 'agent-a', readSet: ['parseConfig'] });
    await handleDeclareFootprint({ directory: b, actorId: 'agent-b', writeSet: ['loadConfig'] });
    write(b, 'src/config.ts', CONFIG_TS.replace('parseConfig("{}")', 'parseConfig("[]")'));
    expect(await peerChangeNotices(a)).toEqual([]);
  });

  it('a peer on an older base is not blamed for a difference it did not make', async () => {
    const { a, b } = clone();
    // The symbol changes on A's branch before A declares: B still has the original, unedited.
    write(a, 'src/config.ts', CONFIG_TS.replace('JSON.parse(s)', 'JSON.parse(s.trimStart())'));
    git(a, 'commit', '-qam', 'a changes parseConfig');
    await handleDeclareFootprint({ directory: a, actorId: 'agent-a', readSet: ['parseConfig'] });
    await handleDeclareFootprint({ directory: b, actorId: 'agent-b', writeSet: ['src/other.ts'] });
    expect(await peerChangeNotices(a)).toEqual([]);
  });

  it('a peer deleting the file of a symbol I declared reading is named', async () => {
    const { a, b } = clone();
    await handleDeclareFootprint({ directory: a, actorId: 'agent-a', readSet: ['parseConfig'] });
    await handleDeclareFootprint({ directory: b, actorId: 'agent-b', writeSet: ['parseConfig'] });
    rmSync(join(b, 'src/config.ts'));
    expect((await peerChangeNotices(a)).map(n => n.symbol)).toEqual(['parseConfig']);
  });

  it('a peer that rebased onto someone else\'s change is not blamed for it', async () => {
    const { a, b } = clone();
    await handleDeclareFootprint({ directory: a, actorId: 'agent-a', readSet: ['parseConfig'] });
    await handleDeclareFootprint({ directory: b, actorId: 'agent-b', writeSet: ['src/other.ts'] });
    const c = `${a}-c`;
    dirs.push(c);
    git(a, 'worktree', 'add', '-q', c, 'main');
    write(c, 'src/config.ts', CONFIG_TS.replace('JSON.parse(s)', 'JSON.parse(s || "{}")'));
    git(c, 'commit', '-qam', 'upstream changes parseConfig');
    git(b, 'rebase', '-q', 'main');
    expect(await peerChangeNotices(a)).toEqual([]);
  });

  it('a board entry whose base is not a commit id is skipped, never passed to git', async () => {
    const { a, b } = clone();
    await handleDeclareFootprint({ directory: a, actorId: 'agent-a', readSet: ['parseConfig'] });
    const dir = (await boardDir(a))!;
    writeFileSync(join(dir, 'forged.json'), JSON.stringify({ version: 1, actorId: 'forged', worktree: b, branch: 'feat-b', writes: [], reads: [], creates: [], declaredAt: new Date().toISOString(), lastSeenAt: new Date().toISOString(), baseAtDeclare: '--output=pwned' }));
    writeFileSync(join(dir, 'bad-read.json'), JSON.stringify({ version: 1, actorId: 'bad', worktree: b, branch: 'feat-b', writes: [], reads: [null], creates: [], declaredAt: new Date().toISOString(), lastSeenAt: new Date().toISOString() }));
    const board = await readBoard(a);
    expect(board.unreadable).toBe(2);
    expect(board.live.map(l => l.entry.actorId)).toEqual(['agent-a']);
  });

  it('no board, or no peers: nothing', async () => {
    const { a } = clone();
    expect(await peerChangeNotices(a)).toEqual([]);
    await handleDeclareFootprint({ directory: a, actorId: 'agent-a', readSet: ['parseConfig'] });
    expect(await peerChangeNotices(a)).toEqual([]);
  });
});
