/**
 * Env vars a diff stops reading, and the infrastructure that still sets them
 * (change: add-iac-code-binding).
 *
 * A name read in a changed code file at the base and read nowhere in the working tree is a
 * removed (or renamed) read. Each one is paired with the declaration sites that still set the old
 * name — the manifests an agent renaming `DATABASE_URL` in code would otherwise miss.
 *
 * Read-only and offline: base blobs via git, working-tree files, a `git grep` to confirm the name
 * is not read elsewhere, and the manifest scan of `env-declaration-scan.ts` (run only when a
 * removed read exists).
 */

import { extname } from 'node:path';
import { execFileGit } from '../../utils/git-exec.js';
import { gitPathArgs } from '../../utils/git-args.js';
import { readFileConfined } from '../../utils/path-confinement.js';
import { readBlobsAtRef, readBlobsPerFile } from '../../utils/git-blobs.js';
import { extractEnvReadSites } from '../analyzer/env-extractor.js';
import type { ChangedFile } from '../../types/index.js';

/** Extensions the env extractor reads. */
const CODE_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.pyw', '.go', '.rb']);
const MAX_FILES = 200;
const MAX_NAMES = 50;
const MAX_BYTES = 1024 * 1024;

export interface StaleEnvDeclaration {
  /** The env var the diff no longer reads. */
  name: string;
  /** Infrastructure sites that still set it (key and location; never the value). */
  sites: Array<{ ecosystem: string; resource: string; file: string; line: number }>;
}

export interface EnvRenameCheck {
  /** Names read at the base in a changed file and read nowhere in the working tree. */
  removedReads: string[];
  stillSet: StaleEnvDeclaration[];
  boundaries: string[];
}

const namesIn = (text: string, path: string): Set<string> =>
  new Set(extractEnvReadSites(text, path, extname(path).toLowerCase()).map(s => s.name));

export async function checkEnvRenames(root: string, baseRef: string, entries: ReadonlyArray<Pick<ChangedFile, 'path' | 'status' | 'oldPath'>>): Promise<EnvRenameCheck> {
  const boundaries: string[] = [];
  const { getRepoPrefix } = await import('../drift/git-diff.js');
  const prefix = (await getRepoPrefix(root)) ?? '';
  // Diff paths are repository-relative; only files under `root` are in scope (the rest cannot be
  // searched or read from here).
  const code = entries.filter(e => CODE_EXT.has(extname(e.path).toLowerCase()) && e.status !== 'added' && e.path.startsWith(prefix));
  if (!code.length) return { removedReads: [], stillSet: [], boundaries };
  if (code.length > MAX_FILES) boundaries.push(`Env-var reads were compared in the first ${MAX_FILES} of ${code.length} changed code files.`);
  const files = code.slice(0, MAX_FILES);
  // The diff runs from the merge-base, so the base side is read there, not at the base branch tip.
  let baseCommit = baseRef;
  try {
    const { stdout } = await execFileGit('git', ['merge-base', baseRef, 'HEAD'], { cwd: root });
    baseCommit = String(stdout).trim() || baseRef;
  } catch { /* unrelated histories: the base tip */ }

  // Diff paths are repository-relative; the working tree is read relative to `root`.
  const basePaths = files.map(e => e.oldPath ?? e.path);
  const blobs = await readBlobsAtRef(root, baseCommit, basePaths).catch(() => readBlobsPerFile(root, baseCommit, basePaths));
  const before = new Set<string>();
  const after = new Set<string>();
  for (const e of files) {
    const basePath = e.oldPath ?? e.path;
    const old = blobs.get(basePath);
    if (old !== undefined && old.length <= MAX_BYTES) for (const n of namesIn(old, basePath)) before.add(n);
    if (e.status === 'deleted') continue;
    try {
      const now = await readFileConfined(root, e.path.slice(prefix.length), MAX_BYTES);
      for (const n of namesIn(now, e.path)) after.add(n);
    } catch {
      boundaries.push(`A changed file could not be read, so its env-var reads were not compared (${e.path}).`);
      // Unknown head reads: treat every base name of this file as still read.
      if (old !== undefined) for (const n of namesIn(old, basePath)) after.add(n);
    }
  }
  let dropped = [...before].filter(n => !after.has(n)).sort();
  if (dropped.length > MAX_NAMES) {
    boundaries.push(`Only the first ${MAX_NAMES} of ${dropped.length} env vars the diff stopped reading were checked.`);
    dropped = dropped.slice(0, MAX_NAMES);
  }

  // A name still read in another file is not removed.
  const changed = new Set(files.map(e => e.path.slice(prefix.length)));
  const removedReads: string[] = [];
  for (const name of dropped) {
    let hits: string[] = [];
    try {
      const { stdout } = await execFileGit('git', gitPathArgs('grep', '-l', '-I', '-F', '-w', '--untracked', '-e', name), { cwd: root, maxBuffer: 16 * 1024 * 1024 });
      hits = String(stdout).split('\n').filter(f => f && CODE_EXT.has(extname(f).toLowerCase()) && !changed.has(f));
    } catch { /* exit 1: no match */ }
    let stillRead = false;
    for (const f of hits) {
      try {
        if (namesIn(await readFileConfined(root, f, MAX_BYTES), f).has(name)) { stillRead = true; break; }
      } catch { /* unreadable: not counted as a read */ }
    }
    if (!stillRead) removedReads.push(name);
  }
  if (!removedReads.length) return { removedReads, stillSet: [], boundaries };

  // Repository text (resource names, paths) is screened before it reaches output.
  const { emittedText } = await import('./generated-file-guard.js');
  const { scanEnvDeclarations } = await import('./env-declaration-scan.js');
  const scan = await scanEnvDeclarations(root);
  boundaries.push(...scan.boundaries);
  if (scan.opaque.length) {
    boundaries.push(`${scan.opaque.length} infrastructure source(s) set variables the scan cannot list (envFrom, env_file, or a map built by an expression); a removed name may still be set there.`);
  }
  const stillSet = removedReads
    .map(name => ({ name, sites: scan.declarations.filter(d => d.name === name).map(d => ({ ecosystem: d.ecosystem, resource: emittedText(d.resource), file: emittedText(d.file), line: d.line })) }))
    .filter(s => s.sites.length);
  return { removedReads, stillSet, boundaries };
}
