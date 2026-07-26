/**
 * The repository being analyzed must not be able to choose where the operator's API
 * key goes, nor waive the TLS verification that protects it in transit.
 *
 * Regression tests for the audit finding that `.openlore/config.json` — a file
 * committed IN the analyzed repo — could set `llm.apiBase` to an attacker host and
 * `llm.sslVerify: false`, collecting ANTHROPIC_API_KEY / OPENAI_API_KEY on the
 * victim's next `generate`, `drift`, or commit (the decisions gate runs
 * consolidation from the pre-commit hook).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  resolveTrustedApiBase,
  resolveTrustedSslVerify,
  rejectRepoConfiguredTlsOptOut,
  discloseRepoConfiguredEndpoint,
} from './repo-config-trust.js';
import { logger } from '../../utils/logger.js';

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(logger, 'warning').mockImplementation(() => {});
});

describe('resolveTrustedApiBase', () => {
  it('drops a repo-config endpoint that would exfiltrate the API key', () => {
    expect(resolveTrustedApiBase(undefined, 'https://attacker.tld/v1')).toBeUndefined();
    expect(vi.mocked(logger.warning)).toHaveBeenCalledWith(
      expect.stringContaining('attacker.tld'),
    );
  });

  it('honours the operator flag even when it is not loopback', () => {
    // `--api-base` comes from the person running the command, not from the clone.
    expect(resolveTrustedApiBase('https://gateway.example/v1', 'https://attacker.tld/v1')).toBe(
      'https://gateway.example/v1',
    );
    expect(vi.mocked(logger.warning)).not.toHaveBeenCalled();
  });

  it('keeps a loopback endpoint from the repo config', () => {
    // Pointing at a local proxy (ollama, LiteLLM) is the legitimate reason to commit
    // this field, and loopback cannot reach an attacker's host.
    for (const url of ['http://localhost:11434/v1', 'http://127.0.0.1:8000', 'http://[::1]:8000']) {
      expect(resolveTrustedApiBase(undefined, url)).toBe(url);
    }
    expect(vi.mocked(logger.warning)).not.toHaveBeenCalled();
  });

  it('drops a malformed endpoint rather than passing it through', () => {
    expect(resolveTrustedApiBase(undefined, 'not a url')).toBeUndefined();
  });

  it('is undefined (provider default) when nothing is configured', () => {
    expect(resolveTrustedApiBase(undefined, undefined)).toBeUndefined();
  });

  it('does not treat a hostname merely CONTAINING a loopback name as loopback', () => {
    // `localhost.attacker.tld` resolves wherever the attacker points it.
    expect(resolveTrustedApiBase(undefined, 'https://localhost.attacker.tld/v1')).toBeUndefined();
    expect(resolveTrustedApiBase(undefined, 'https://127.0.0.1.attacker.tld/v1')).toBeUndefined();
  });
});

describe('resolveTrustedSslVerify', () => {
  it('ignores sslVerify:false from the repo config', () => {
    expect(resolveTrustedSslVerify(undefined, false)).toBe(true);
    expect(vi.mocked(logger.warning)).toHaveBeenCalledWith(expect.stringContaining('--insecure'));
  });

  it('honours --insecure from the operator', () => {
    expect(resolveTrustedSslVerify(true, undefined)).toBe(false);
  });

  it('honours an explicit --no-insecure over a repo opt-out', () => {
    expect(resolveTrustedSslVerify(false, false)).toBe(true);
  });

  it('verifies by default', () => {
    expect(resolveTrustedSslVerify(undefined, undefined)).toBe(true);
    expect(resolveTrustedSslVerify(undefined, true)).toBe(true);
  });
});

describe('rejectRepoConfiguredTlsOptOut', () => {
  it('always answers "do not skip verification"', () => {
    expect(rejectRepoConfiguredTlsOptOut('embedding.skipSslVerify', true)).toBe(false);
    expect(vi.mocked(logger.warning)).toHaveBeenCalledWith(
      expect.stringContaining('embedding.skipSslVerify'),
    );
  });

  it('stays quiet when the field was never set', () => {
    expect(rejectRepoConfiguredTlsOptOut('embedding.skipSslVerify', undefined)).toBe(false);
    expect(vi.mocked(logger.warning)).not.toHaveBeenCalled();
  });
});

describe('discloseRepoConfiguredEndpoint', () => {
  it('names a non-loopback host the repo config points credentials at', () => {
    discloseRepoConfiguredEndpoint('generation.openaiCompatBaseUrl', 'https://gw.attacker.tld/v1');
    expect(vi.mocked(logger.warning)).toHaveBeenCalledWith(
      expect.stringContaining('gw.attacker.tld'),
    );
  });

  it('stays quiet for loopback and for an absent value', () => {
    discloseRepoConfiguredEndpoint('embedding.baseUrl', 'http://localhost:11434/v1');
    discloseRepoConfiguredEndpoint('embedding.baseUrl', undefined);
    expect(vi.mocked(logger.warning)).not.toHaveBeenCalled();
  });
});
