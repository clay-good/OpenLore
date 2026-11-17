/**
 * Retrieval benchmark: keyword+vocabulary vs local-semantic, on fixed queries with known
 * target symbols (change: enable-local-semantic-search-in-background).
 *
 * For each corpus it clones the source twice (`git clone --local`, so the original is never
 * touched), builds a keyword index (`analyze --force --no-embed`) and a local-semantic index
 * (`embedding.provider: "local"` + `analyze --force`), then asks every query through
 * `handleOrient` — the path an agent's `orient` call takes — and scores `relevantFunctions`.
 *
 *   npm run build
 *   npm run bench:retrieval -- --work <scratch dir> \
 *     --corpus openlore=<repo> --corpus gridprims=<repo> --corpus roughlogic=<repo> [--json <out>]
 *
 * A query hits at rank r when any listed target (name, and file when given) is the r-th
 * function returned. recall@5 = share of queries with a hit in the top 5; MRR is over the
 * top 10. Build time is wall time of the analyze run; the model download is not included
 * when the model is already cached under ~/.openlore/models.
 *
 * Not part of any test suite: it needs the built CLI, real repositories, and minutes.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const cli = join(root, 'dist', 'cli', 'index.js');
const MODES = ['keyword', 'local-semantic'] as const;

interface Target { name: string; file?: string }
interface Query { kind: 'identifier' | 'paraphrase'; query: string; targets: Target[] }
interface QuerySet { corpus: string; queries: Query[] }
interface QueryOutcome { query: string; kind: Query['kind']; rank: number | null; retrievalMode: string }

function args(flag: string): string[] {
  const out: string[] = [];
  process.argv.forEach((value, i) => { if (value === flag && process.argv[i + 1]) out.push(process.argv[i + 1]); });
  return out;
}

/** The environment of a user with no remote endpoint: the local provider or nothing. */
function benchEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.EMBED_BASE_URL;
  delete env.EMBED_MODEL;
  delete env.EMBED_API_KEY;
  return env;
}

function run(cmd: string, argv: string[], cwd: string): void {
  execFileSync(cmd, argv, { cwd, env: benchEnv(), stdio: ['ignore', 'ignore', 'inherit'] });
}

function duKb(path: string): number {
  if (!existsSync(path)) return 0;
  return Number(execFileSync('du', ['-sk', path], { encoding: 'utf8' }).split(/\s+/)[0]);
}

function matches(fn: { name?: string; filePath?: string }, target: Target): boolean {
  const name = fn.name ?? '';
  const nameOk = name === target.name || name.endsWith(`.${target.name}`);
  return nameOk && (!target.file || (fn.filePath ?? '').endsWith(target.file));
}

/** Child process: answer every query against one built index and print the ranks. */
async function queryIndex(dir: string, set: QuerySet): Promise<QueryOutcome[]> {
  const { handleOrient } = await import(pathToFileURL(join(root, 'dist/core/services/mcp-handlers/orient.js')).href) as {
    handleOrient: (dir: string, task: string, limit: number) => Promise<unknown>;
  };
  const out: QueryOutcome[] = [];
  for (const q of set.queries) {
    const res = await handleOrient(dir, q.query, 10) as {
      retrievalMode?: string;
      relevantFunctions?: Array<{ name?: string; filePath?: string }>;
    };
    const fns = res.relevantFunctions ?? [];
    const idx = fns.findIndex(fn => q.targets.some(t => matches(fn, t)));
    out.push({ query: q.query, kind: q.kind, rank: idx >= 0 ? idx + 1 : null, retrievalMode: res.retrievalMode ?? 'unknown' });
  }
  return out;
}

function score(outcomes: QueryOutcome[]): { recallAt5: number; mrr: number } {
  const n = outcomes.length || 1;
  const hits = outcomes.filter(o => o.rank !== null && o.rank <= 5).length;
  const rr = outcomes.reduce((sum, o) => sum + (o.rank !== null ? 1 / o.rank : 0), 0);
  return { recallAt5: hits / n, mrr: rr / n };
}

/** Every target must be a symbol the index actually holds, or the query is unfair. */
function assertTargetsIndexed(dir: string, set: QuerySet): void {
  const db = join(dir, '.openlore', 'analysis', 'call-graph.db');
  const rows = execFileSync('sqlite3', ['-separator', '\t', db, 'select name, file_path from nodes where is_external = 0'], {
    encoding: 'utf8', maxBuffer: 256 * 1024 * 1024,
  }).split('\n').map(line => line.split('\t'));
  for (const q of set.queries) {
    const found = q.targets.some(t => rows.some(([name, filePath]) => matches({ name, filePath }, t)));
    if (!found) throw new Error(`${set.corpus}: no indexed target for "${q.query}"`);
  }
}

async function main(): Promise<void> {
  if (process.argv.includes('--query-child')) {
    const [dir] = args('--dir');
    const [queries] = args('--queries');
    const set = JSON.parse(readFileSync(queries, 'utf8')) as QuerySet;
    // A file, not stdout: the handlers log to stdout.
    const [out] = args('--out');
    writeFileSync(out, JSON.stringify(await queryIndex(dir, set)));
    return;
  }

  const [work] = args('--work');
  const corpora = args('--corpus').map(spec => spec.split('=') as [string, string]);
  if (!work || corpora.length === 0) throw new Error('usage: --work <dir> --corpus <name>=<repo> [...] [--json <out>]');
  if (!existsSync(cli)) throw new Error('run "npm run build" first');

  const results: Array<Record<string, unknown>> = [];
  for (const [name, source] of corpora) {
    const queriesPath = join(root, 'bench', 'retrieval', 'queries', `${name}.json`);
    const set = JSON.parse(readFileSync(queriesPath, 'utf8')) as QuerySet;
    for (const mode of MODES) {
      const dir = join(work, `${name}-${mode}`);
      if (!existsSync(dir)) run('git', ['clone', '--quiet', '--local', resolve(source), dir], work);
      if (!existsSync(join(dir, '.openlore', 'config.json'))) run('node', [cli, 'init'], dir);
      const configPath = join(dir, '.openlore', 'config.json');
      const config = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>;
      config.embedding = mode === 'local-semantic' ? { provider: 'local' } : null;
      writeFileSync(configPath, JSON.stringify(config, null, 2));

      const started = Date.now();
      run('node', [cli, 'analyze', '--force', ...(mode === 'keyword' ? ['--no-embed'] : [])], dir);
      const buildSeconds = (Date.now() - started) / 1000;
      assertTargetsIndexed(dir, set);

      const outFile = join(work, `${name}-${mode}.outcomes.json`);
      run('node', ['--import', 'tsx', fileURLToPath(import.meta.url), '--query-child', '--dir', dir, '--queries', queriesPath, '--out', outFile], root);
      const outcomes = JSON.parse(readFileSync(outFile, 'utf8')) as QueryOutcome[];

      const served = [...new Set(outcomes.map(o => o.retrievalMode))];
      if (mode === 'local-semantic' && !served.includes('local-semantic')) {
        throw new Error(`${name}: semantic run served ${served.join(', ')} — vectors were not built`);
      }
      const row = {
        corpus: name,
        mode,
        served,
        queries: outcomes.length,
        ...score(outcomes),
        identifier: score(outcomes.filter(o => o.kind === 'identifier')),
        paraphrase: score(outcomes.filter(o => o.kind === 'paraphrase')),
        buildSeconds,
        analysisDiskKb: duKb(join(dir, '.openlore', 'analysis')),
        vectorIndexDiskKb: duKb(join(dir, '.openlore', 'analysis', 'vector-index')),
        outcomes,
      };
      results.push(row);
      console.error(`${name.padEnd(12)} ${mode.padEnd(15)} recall@5 ${(row.recallAt5 * 100).toFixed(1)}%  MRR ${row.mrr.toFixed(3)}  build ${buildSeconds.toFixed(1)} s  disk ${(row.analysisDiskKb / 1024).toFixed(1)} MB`);
    }
  }

  const [jsonOut] = args('--json');
  if (jsonOut) writeFileSync(jsonOut, JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2));
  else console.log(JSON.stringify(results.map(row => ({ ...row, outcomes: undefined })), null, 2));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
