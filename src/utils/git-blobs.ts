/**
 * Reading many file blobs at a git ref, in one subprocess.
 *
 * `git show ref:path` per file is the obvious way and the slow one: on a real repository the spawns
 * dominate everything else. `git cat-file --batch` answers the whole list over one pipe, correlating
 * each reply to the fed path BY ORDER (a `missing` reply advances the cursor with no body). The
 * batch read rejects on any protocol or size violation, and the per-file reader stays as the
 * correctness fallback, so the fast path is never load-bearing.
 *
 * Shared by the merge-semantic certificate (a whole tree at a ref) and the phantom-reference check
 * (the base revision of a diff's files).
 */

import { execFileGit, spawnGit } from './git-exec.js';
import { gitPathArgs } from './git-args.js';

const GIT_READ_TIMEOUT_MS = 20_000;
/** Total bytes one batch read may return before it is refused. */
const MAX_BLOB_BYTES_TOTAL = 512 * 1024 * 1024;

/**
 * Read many blobs at a ref in ONE `git cat-file --batch`, correlating each reply to the fed path by
 * ORDER (a `missing` reply advances the cursor with no body). Replaces one `git show` subprocess
 * per file, the dominant cost on a real repo. Rejects on a protocol or size violation, which the
 * caller turns into a per-file fallback, so this fast path is never load-bearing for correctness.
 */
export function readBlobsAtRef(absDir: string, ref: string, paths: readonly string[]): Promise<Map<string, string>> {
  return new Promise((resolve, reject) => {
    // Specs are fed one per line and replies are correlated BY ORDER, so a path containing a
    // newline would be two requests and shift every later reply onto the wrong file. Such a path is
    // legal in a repository, so the batch refuses the whole call and the per-file reader takes over.
    const newline = paths.find(p => p.includes('\n'));
    if (newline !== undefined) {
      reject(new Error('git cat-file --batch cannot address a path containing a newline'));
      return;
    }
    const child = spawnGit('git', gitPathArgs('cat-file', '--batch'), { cwd: absDir, stdio: ['pipe', 'pipe', 'pipe'] });
    const out = new Map<string, string>();
    const decoder = new TextDecoder('utf-8');
    let pending: Buffer = Buffer.alloc(0);
    let idx = 0;
    let need: number | null = null;
    let total = 0;
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill(); } catch { /* already exited */ }
      fn();
    };
    const fail = (e: Error): void => finish(() => reject(e));
    const timer = setTimeout(() => fail(new Error('git cat-file --batch timed out')), GIT_READ_TIMEOUT_MS);
    child.on('error', fail);
    child.stdin.on('error', fail);
    child.stdout.on('error', fail);
    child.stdout.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BLOB_BYTES_TOTAL) { fail(new Error('git cat-file --batch output exceeded the size bound')); return; }
      pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
      try {
        while (idx < paths.length) {
          if (need === null) {
            const nl = pending.indexOf(0x0a);
            if (nl === -1) return; // header incomplete; wait for more
            const header = pending.subarray(0, nl).toString('ascii').trim();
            pending = pending.subarray(nl + 1);
            const tok = header.split(/\s+/);
            if (tok[tok.length - 1] === 'missing') { idx++; continue; } // path absent at this ref
            const size = Number(tok[tok.length - 1]);
            if (!Number.isSafeInteger(size) || size < 0) throw new Error(`unexpected cat-file header: ${header}`);
            need = size;
          }
          if (pending.length < need + 1) return; // body + trailing newline not yet buffered
          if (pending[need] !== 0x0a) throw new Error('cat-file blob was not newline-terminated');
          out.set(paths[idx], decoder.decode(pending.subarray(0, need)));
          pending = pending.subarray(need + 1);
          need = null;
          idx++;
        }
        finish(() => resolve(out));
      } catch (e) {
        fail(e instanceof Error ? e : new Error(String(e)));
      }
    });
    // Git closes stdout when stdin ends; resolve with whatever was parsed (partial is fail-soft).
    child.stdout.on('end', () => finish(() => resolve(out)));
    child.stdin.end(paths.map(p => `${ref}:${p}`).join('\n') + '\n');
  });
}

/** Per-file `git show` — the correctness fallback when the batch read fails. */
export async function readBlobsPerFile(absDir: string, ref: string, paths: readonly string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const path of paths) {
    try {
      const { stdout } = await execFileGit('git', gitPathArgs('show', `${ref}:${path}`), { cwd: absDir, timeout: GIT_READ_TIMEOUT_MS });
      out.set(path, stdout);
    } catch { /* unreadable at this ref — skipped, disclosed via the overall boundary */ }
  }
  return out;
}
