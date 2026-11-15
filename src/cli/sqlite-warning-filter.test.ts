import { afterAll, describe, expect, it, vi } from 'vitest';

describe('sqlite warning filter', () => {
  const seen: Array<{ name: string; message: string }> = [];
  const listener = (w: Error) => { seen.push({ name: w.name, message: w.message }); };
  process.on('warning', listener);
  afterAll(() => { process.off('warning', listener); });

  const warning = (name: string, message: string) => Object.assign(new Error(message), { name });

  it('drops only the SQLite experimental warning', async () => {
    const original = process.emit;
    try {
      await import('./sqlite-warning-filter.js');
      process.emit('warning', warning('ExperimentalWarning', 'SQLite is an experimental feature and might change at any time'));
      process.emit('warning', warning('ExperimentalWarning', 'VM Modules is an experimental feature'));
      process.emit('warning', warning('DeprecationWarning', 'SQLite something deprecated'));
      expect(seen).toEqual([
        { name: 'ExperimentalWarning', message: 'VM Modules is an experimental feature' },
        { name: 'DeprecationWarning', message: 'SQLite something deprecated' },
      ]);
      // Other events pass through unchanged.
      const spy = vi.fn();
      process.on('openlore-test-event' as 'warning', spy);
      process.emit('openlore-test-event' as 'warning', warning('x', 'y'));
      expect(spy).toHaveBeenCalledTimes(1);
      process.off('openlore-test-event' as 'warning', spy);
    } finally {
      process.emit = original;
    }
  });
});
