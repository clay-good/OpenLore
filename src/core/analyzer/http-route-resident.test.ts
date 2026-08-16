import { describe, expect, it, vi } from 'vitest';

const { openMock } = vi.hoisted(() => ({
  openMock: vi.fn(async () => { throw new Error('resident-source extraction must not open files'); }),
}));

vi.mock('node:fs/promises', async importOriginal => ({
  ...await importOriginal<typeof import('node:fs/promises')>(),
  open: openMock,
}));

import { extractAllHttpEdges } from './http-route-parser.js';

describe('resident HTTP source reuse', () => {
  it('extracts nonempty calls, routes, and edges with zero file opens', async () => {
    const result = await extractAllHttpEdges([
      {
        path: '/does-not-exist/client.ts',
        content: `export async function load() { return fetch('/api/items'); }`,
      },
      {
        path: '/does-not-exist/routes.py',
        content: `from fastapi import FastAPI\napp = FastAPI()\n@app.get('/api/items')\ndef items():\n    return []\n`,
      },
    ]);

    expect(result.calls).not.toHaveLength(0);
    expect(result.routes).not.toHaveLength(0);
    expect(result.edges).not.toHaveLength(0);
    expect(openMock).not.toHaveBeenCalled();
  });
});
