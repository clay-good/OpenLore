import { describe, expect, it } from 'vitest';
import { LocalEmbeddingService } from './local-embedding-service.js';

describe('LocalEmbeddingService.shared', () => {
  it('reuses one instance per model, so the loaded model is not rebuilt on every query', () => {
    expect(LocalEmbeddingService.shared()).toBe(LocalEmbeddingService.shared());
    expect(LocalEmbeddingService.fromConfig({ provider: 'local' })).toBe(LocalEmbeddingService.fromConfig({ provider: 'local' }));
    expect(LocalEmbeddingService.shared('Xenova/all-MiniLM-L6-v2', 8)).not.toBe(LocalEmbeddingService.shared('Xenova/all-MiniLM-L6-v2', 16));
  });
});
