/**
 * The native-LanceDB log level is quieted to errors by default, but a level the
 * user set on purpose is never overridden (change: fix-cli-output-hygiene).
 */

import { describe, it, expect, afterEach } from 'vitest';
import { quietNativeLoggingOnce } from './lance-logging.js';

describe('quietNativeLoggingOnce', () => {
  const saved = process.env.LANCEDB_LOG;
  afterEach(() => {
    if (saved === undefined) delete process.env.LANCEDB_LOG;
    else process.env.LANCEDB_LOG = saved;
  });

  it('sets LANCEDB_LOG=error when unset', () => {
    delete process.env.LANCEDB_LOG;
    quietNativeLoggingOnce();
    expect(process.env.LANCEDB_LOG).toBe('error');
  });

  it('never overrides an explicit user setting', () => {
    process.env.LANCEDB_LOG = 'debug';
    quietNativeLoggingOnce();
    expect(process.env.LANCEDB_LOG).toBe('debug');
  });
});
