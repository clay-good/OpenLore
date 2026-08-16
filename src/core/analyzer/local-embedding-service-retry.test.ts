import { beforeEach, describe, expect, it, vi } from 'vitest';

const pipeline = vi.fn();

vi.mock('@huggingface/transformers', () => ({
  env: {},
  pipeline,
}));

import { LocalEmbeddingService } from './local-embedding-service.js';

describe('LocalEmbeddingService extractor retry', () => {
  beforeEach(() => pipeline.mockReset());

  it('retries a transient model-load failure on the same service instance', async () => {
    const extractor = vi.fn().mockResolvedValue({ tolist: () => [[0.1, 0.2]] });
    pipeline
      .mockRejectedValueOnce(new Error('transient download failure'))
      .mockResolvedValueOnce(extractor);
    const service = new LocalEmbeddingService('test/model');

    await expect(service.embed(['first'])).rejects.toThrow('transient download failure');
    await expect(service.embed(['second'])).resolves.toEqual([[0.1, 0.2]]);
    expect(pipeline).toHaveBeenCalledTimes(2);
  });
});
