/**
 * The bounded artifact read (change: refine-first-run-partial-serving extracted it here).
 *
 * The cases below are the ones a hostile repository can actually plant under `.openlore/`.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, symlink, mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readArtifactBounded, readArtifactBytesBounded } from './bounded-artifact-read.js';

let dir: string;

beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'openlore-bounded-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe('readArtifactBytesBounded', () => {
  it('reads a regular file and distinguishes absent from refused', async () => {
    await writeFile(join(dir, 'ok.json'), '{"a":1}', 'utf8');

    const ok = await readArtifactBytesBounded(join(dir, 'ok.json'));
    expect(ok.state).toBe('ok');
    expect(ok.state === 'ok' && ok.bytes.toString('utf8')).toBe('{"a":1}');

    // Absent and refused must stay distinguishable: a caller that treats "no such file" as a
    // legitimate state must not treat a poisoned one the same way.
    expect((await readArtifactBytesBounded(join(dir, 'nope.json'))).state).toBe('absent');
    await mkdir(join(dir, 'adir'));
    expect((await readArtifactBytesBounded(join(dir, 'adir'))).state).toBe('refused');
  });

  it('refuses a symlink rather than following it', async () => {
    await writeFile(join(dir, 'real.json'), '{"secret":1}', 'utf8');
    await symlink(join(dir, 'real.json'), join(dir, 'link.json'));

    expect((await readArtifactBytesBounded(join(dir, 'link.json'))).state).toBe('refused');
    expect(await readArtifactBounded(join(dir, 'link.json'))).toBeNull();
  });

  it.runIf(process.platform !== 'win32')('refuses a FIFO instead of blocking in open()', async () => {
    // The failure this closes: `open()` on a read-only FIFO blocks until a writer appears — and
    // it blocks on a libuv threadpool worker, which `process.exit` cannot interrupt. A hostile
    // repository shipping one under `.openlore/` could hang a tool call permanently AND stop
    // the server from shutting down. `O_NOFOLLOW` does not help: a FIFO is not a symlink.
    const fifo = join(dir, 'pipe.json');
    execFileSync('mkfifo', [fifo]);

    const settled = await Promise.race([
      readArtifactBytesBounded(fifo).then(r => r.state),
      new Promise<string>(resolve => setTimeout(() => resolve('HUNG'), 3000)),
    ]);

    expect(settled).toBe('refused');
  });
});
