/**
 * Length-sorted batching in LocalEmbeddingService.embed: batches hold texts of similar length
 * (each is padded to its longest), every vector comes back at its caller's index, and texts are
 * capped before tokenizing.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const pipeline = vi.fn();

vi.mock('@huggingface/transformers', () => ({
  env: {},
  pipeline,
}));

import { LOCAL_MODEL_MAX_TOKENS, LocalEmbeddingService } from './local-embedding-service.js';

/** A fake model whose vector names the text it came from, and that records each batch. */
function recordingExtractor(batches: string[][]) {
  return vi.fn(async (texts: string[]) => {
    batches.push(texts);
    return { tolist: () => texts.map(text => [text.length, text.charCodeAt(0)]) };
  });
}

describe('LocalEmbeddingService.embed batching', () => {
  beforeEach(() => pipeline.mockReset());

  it('returns each vector at its own index although batches run sorted by length', async () => {
    const batches: string[][] = [];
    pipeline.mockResolvedValue(recordingExtractor(batches));
    const texts = ['c'.repeat(300), 'a', 'b'.repeat(40), 'd'.repeat(5), 'e'.repeat(1000), 'f'.repeat(2)];
    const service = new LocalEmbeddingService('test/model', 2);

    const vectors = await service.embed(texts);

    expect(vectors).toEqual(texts.map(text => [text.length, text.charCodeAt(0)]));
    // Short with short, long with long.
    expect(batches.map(batch => batch.map(text => text.length))).toEqual([[1, 2], [5, 40], [300, 1000]]);
  });

  it('caps a text before the model sees it, far past the 512-token window', async () => {
    const batches: string[][] = [];
    pipeline.mockResolvedValue(recordingExtractor(batches));
    const service = new LocalEmbeddingService('test/model');

    await service.embed(['x'.repeat(50_000)]);

    expect(batches[0][0].length).toBe(8192);
  });

  it('keeps small calls on this thread (no worker pool for queries)', async () => {
    const batches: string[][] = [];
    pipeline.mockResolvedValue(recordingExtractor(batches));
    const service = new LocalEmbeddingService('test/model');

    expect(await service.embed(['one query'])).toEqual([[9, 'o'.charCodeAt(0)]]);
    expect(batches).toEqual([['one query']]);
  });

  it('reads at most the 256 tokens the model was trained on, though the library exposes a getter', async () => {
    // As in @huggingface/transformers: the limit is a getter over the tokenizer config (512).
    class Tokenizer { get model_max_length(): number { return 512; } }
    const tokenizer = new Tokenizer();
    const batches: string[][] = [];
    pipeline.mockResolvedValue(Object.assign(recordingExtractor(batches), { tokenizer }));

    await new LocalEmbeddingService('test/model').embed(['load']);

    expect(LOCAL_MODEL_MAX_TOKENS).toBe(256);
    expect(tokenizer.model_max_length).toBe(256);
  });
});
