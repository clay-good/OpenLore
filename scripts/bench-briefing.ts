/**
 * bench-briefing.ts — how useful is the prompt briefing on YOUR real prompts?
 *
 * Replays the human prompts from local Claude Code transcripts of this repository through the
 * built `openlore orient --inject` (each in a fresh session) and scores every briefing against the
 * files the agent then read or edited in that turn. Deterministic: no LLM judge. Local only: the
 * transcripts are read from ~/.claude/projects and nothing is sent anywhere; only aggregates print.
 *
 * Run (after `npm run build`):
 *   npm run bench:briefing                       # transcripts of this repository and its worktrees
 *   npm run bench:briefing -- --transcripts '<glob dir>' --json
 *
 * Manual benchmark, not part of CI. change: anchor-gated-prompt-briefing
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scoreBriefings, turnsFromTranscript } from '../src/bench/transcript-turns.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(ROOT, 'dist', 'cli', 'index.js');
const arg = (flag: string): string | undefined => { const i = process.argv.indexOf(flag); return i >= 0 ? process.argv[i + 1] : undefined; };

if (!existsSync(CLI)) { console.error('Build first: npm run build'); process.exit(1); }

// Claude Code names a project folder after its absolute path with separators replaced by '-'. The
// main checkout and its worktrees share the main checkout's prefix.
const mainRoot = ROOT.includes('/.claude/worktrees/') ? ROOT.slice(0, ROOT.indexOf('/.claude/worktrees/')) : ROOT;
const projectsDir = arg('--transcripts') ?? join(homedir(), '.claude', 'projects');
const prefix = mainRoot.replace(/[^A-Za-z0-9]/g, '-');
const folders = existsSync(projectsDir) ? readdirSync(projectsDir).filter(d => d === prefix || d.startsWith(`${prefix}-`)) : [];
const roots = [mainRoot, ...readdirSync(join(mainRoot, '.claude', 'worktrees'), { withFileTypes: true }).filter(d => d.isDirectory()).map(d => join(mainRoot, '.claude', 'worktrees', d.name))].filter(existsSync);

const turns = folders.flatMap(folder => readdirSync(join(projectsDir, folder)).filter(f => f.endsWith('.jsonl'))
  .flatMap(f => turnsFromTranscript(readFileSync(join(projectsDir, folder, f), 'utf8'), [...roots, ...worktreeRootsFrom(folder)])))
  .filter(t => t.touched.length > 0);

function worktreeRootsFrom(folder: string): string[] {
  const m = folder.match(/--claude-worktrees-(.+)$/);
  return m ? [join(mainRoot, '.claude', 'worktrees', m[1])] : [];
}

const rows = turns.map((t, i) => {
  const r = spawnSync(process.execPath, [CLI, 'orient', '--inject'], {
    cwd: ROOT, encoding: 'utf8', timeout: 30_000,
    input: JSON.stringify({ prompt: t.prompt, cwd: ROOT, session_id: `bench-briefing-${process.pid}-${i}`, hook_event_name: 'UserPromptSubmit' }),
  });
  let briefing = r.stdout ?? '';
  try { briefing = (JSON.parse(briefing) as { hookSpecificOutput?: { additionalContext?: string } }).hookSpecificOutput?.additionalContext ?? briefing; } catch { /* plain text */ }
  return { briefing, touched: t.touched };
});
const score = scoreBriefings(rows);
if (process.argv.includes('--json')) {
  process.stdout.write(`${JSON.stringify({ transcripts: folders.length, ...score }, null, 2)}\n`);
} else {
  console.log(`transcript folders: ${folders.length} (${basename(mainRoot)} and its worktrees)`);
  console.log(`real prompts followed by file work: ${score.prompts}`);
  console.log(`briefings: ${score.briefings}; naming >=1 file the agent then touched: ${score.withHit}`);
  console.log(`mean precision of named files: ${(score.meanPrecision * 100).toFixed(0)}%; mean size: ${score.meanChars} chars`);
}
