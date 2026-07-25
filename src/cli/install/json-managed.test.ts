import { describe, it, expect } from 'vitest';
import {
  mergeEntries,
  readMeta,
  isHandEdited,
  removeManaged,
  canonicalJsonHash,
} from './json-managed.js';

describe('json-managed', () => {
  it('creates managed entries with a meta block', () => {
    const { next, action } = mergeEntries({}, [
      { path: 'mcpServers.openlore', value: { command: 'npx' } },
    ]);
    expect(action).toBe('created');
    const meta = readMeta(next);
    expect(meta?.managed).toBe(true);
    expect(meta?.paths).toEqual(['mcpServers.openlore']);
    expect(meta?.fingerprint).toMatch(/^[0-9a-f]+$/);
  });

  it('is a no-op when re-applying identical entries', () => {
    const { next: first } = mergeEntries({}, [
      { path: 'mcpServers.openlore', value: { a: 1 } },
    ]);
    const { action } = mergeEntries(first, [
      { path: 'mcpServers.openlore', value: { a: 1 } },
    ]);
    expect(action).toBe('noop');
  });

  it('updates when value changes', () => {
    const { next: first } = mergeEntries({}, [
      { path: 'mcpServers.openlore', value: { a: 1 } },
    ]);
    const { action, next } = mergeEntries(first, [
      { path: 'mcpServers.openlore', value: { a: 2 } },
    ]);
    expect(action).toBe('updated');
    expect((next.mcpServers as Record<string, { a: number }>).openlore.a).toBe(2);
  });

  it('detects hand-edits to a managed path', () => {
    const { next } = mergeEntries({}, [
      { path: 'mcpServers.openlore', value: { a: 1 } },
    ]);
    (next.mcpServers as Record<string, { a: number }>).openlore.a = 999;
    const meta = readMeta(next)!;
    expect(isHandEdited(next, meta)).toBe(true);
  });

  it('preserves unrelated keys after merge', () => {
    const existing = { otherKey: { keep: true } } as Record<string, unknown>;
    const { next } = mergeEntries(existing, [
      { path: 'mcpServers.openlore', value: { a: 1 } },
    ]);
    expect((next.otherKey as { keep: boolean }).keep).toBe(true);
  });

  it('removeManaged strips only managed paths', () => {
    const existing = { otherKey: { keep: true } } as Record<string, unknown>;
    const { next: merged } = mergeEntries(existing, [
      { path: 'mcpServers.openlore', value: { a: 1 } },
    ]);
    const { next: stripped, removed } = removeManaged(merged);
    expect(removed).toBe(true);
    expect(stripped._openlore).toBeUndefined();
    expect((stripped.otherKey as { keep: boolean }).keep).toBe(true);
    expect(stripped.mcpServers).toBeUndefined();
  });

  it('canonicalJsonHash is stable across key order', () => {
    expect(canonicalJsonHash({ a: 1, b: 2 })).toBe(canonicalJsonHash({ b: 2, a: 1 }));
  });

  // A managed path is written key-by-key into a plain object, so a `__proto__`
  // segment would assign onto Object.prototype and leak into every object in the
  // process rather than into the config document.
  //
  // The two directions are treated differently ON PURPOSE, because the paths come
  // from different places:
  //   - entries[].path is chosen by OUR code (install adapters, internal constants),
  //     so an unsafe value there is a programmer error and should be loud.
  //   - _openlore.paths is read back off the user's config file, so it is untrusted
  //     data. Throwing on it would turn a hand-edited file into a crashed install;
  //     OpenLore never writes such a path, so it cannot describe anything we manage
  //     and is simply ignored.
  it('throws on a prototype-polluting path supplied by our own code', () => {
    expect(() => mergeEntries({}, [{ path: '__proto__.polluted', value: 'x' }])).toThrow(
      /prototype-polluting/
    );
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('ignores a prototype-polluting path found in the document, without crashing', () => {
    const doc = {
      _openlore: {
        managed: true,
        version: 1,
        fingerprint: 'x',
        paths: ['__proto__.bad', 'mcpServers.openlore'],
      },
      mcpServers: { openlore: { command: 'x' } },
    } as Record<string, unknown>;

    // Uninstall proceeds and still removes the real managed path.
    const { next, removed } = removeManaged(doc);
    expect(removed).toBe(true);
    expect(next.mcpServers).toBeUndefined();

    // Install-over also proceeds rather than throwing.
    expect(() => mergeEntries(doc, [{ path: 'mcpServers.openlore', value: { command: 'y' } }])).not.toThrow();

    expect(({} as Record<string, unknown>).bad).toBeUndefined();
  });
});
