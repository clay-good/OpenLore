import { describe, expect, it } from 'vitest';
import { readBenchmarkContainerSpec } from './container-launch.js';

describe('benchmark container specification', () => {
  it('binds the repository Dockerfile to the corpus base-image digest', () => {
    const expected = 'docker.io/library/node:24-bookworm@sha256:be23f54a88d34e8824c741b19b91064094f92c1c97b194144bfc8b50d67258e2';
    expect(readBenchmarkContainerSpec(process.cwd(), expected)).toMatchObject({
      baseImage: expected,
      definitionSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      tag: expect.stringMatching(/^openlore-benchmark:[a-f0-9]{16}$/),
    });
  });

  it('rejects a corpus image that the Dockerfile does not build from', () => {
    expect(() => readBenchmarkContainerSpec(process.cwd(), `example.test/node@sha256:${'a'.repeat(64)}`))
      .toThrow('Benchmark Dockerfile base does not match the corpus image');
  });
});
