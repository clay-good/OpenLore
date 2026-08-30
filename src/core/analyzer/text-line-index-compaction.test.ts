import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('./index-compaction.js', () => ({
  noteUpdateAndMaybeCompact: vi.fn().mockResolvedValue(false),
}));

import { noteUpdateAndMaybeCompact } from './index-compaction.js';
import { TextLineIndex, _resetTextLineIndexCachesForTesting } from './text-line-index.js';

describe('TextLineIndex compaction accounting', () => {
  let outputDir: string;

  beforeEach(async () => {
    outputDir = await mkdtemp(join(tmpdir(), 'ol-text-compaction-'));
    _resetTextLineIndexCachesForTesting();
  });

  afterEach(async () => {
    vi.clearAllMocks();
    _resetTextLineIndexCachesForTesting();
    await rm(outputDir, { recursive: true, force: true });
  });

  it('reports deleted rows rather than affected file count', async () => {
    const original = Array.from({ length: 75 }, (_, index) => `line ${index}`).join('\n');
    await TextLineIndex.build(outputDir, [{ filePath: 'large.txt', content: original }]);

    await TextLineIndex.updateFiles(outputDir, [{ filePath: 'large.txt', content: 'replacement' }]);

    expect(noteUpdateAndMaybeCompact).toHaveBeenCalledWith(
      expect.any(String),
      expect.anything(),
      75,
    );
  });
});
