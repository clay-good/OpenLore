import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { readStdin } from './stdin.js';

function fakeStream(): PassThrough & { isTTY?: boolean } {
  return new PassThrough() as PassThrough & { isTTY?: boolean };
}

describe('readStdin byte bound', () => {
  it('rejects and detaches immediately when one chunk exceeds the cap', async () => {
    const stream = fakeStream();
    const result = readStdin(stream as unknown as NodeJS.ReadStream, 5_000, 8);
    stream.write('123456789');

    await expect(result).rejects.toThrow('8-byte safety limit');
    expect(stream.isPaused()).toBe(true);
    expect(stream.listenerCount('data')).toBe(0);
    expect(stream.listenerCount('end')).toBe(0);
  });

  it('enforces the byte cap across streamed chunks instead of per chunk', async () => {
    const stream = fakeStream();
    const result = readStdin(stream as unknown as NodeJS.ReadStream, 5_000, 8);
    stream.write('1234');
    stream.write('5678');
    stream.write('9');

    await expect(result).rejects.toThrow('8-byte safety limit');
  });

  it('bounds payload bytes already buffered before listeners attach', async () => {
    const stream = fakeStream();
    stream.end('123456789');

    await expect(readStdin(stream as unknown as NodeJS.ReadStream, 5_000, 8))
      .rejects.toThrow('8-byte safety limit');
  });
});
