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

// ============================================================================
// Coverage: no unguarded door is left open
// ============================================================================

describe('every credential-bearing config read goes through the trust boundary', () => {
  // A structural test, because the first pass at this fix guarded the CLI commands
  // and left the embeddable API (`src/api/*`) and the viewer's chat agent reading the
  // same untrusted fields directly — the guard existing is not the same as the guard
  // being applied, which is the failure mode this whole change is about.
  it('has no raw `?? config.llm?.apiBase` / `?? config.llm?.sslVerify` fallback left', async () => {
    const { readFileSync, readdirSync, statSync } = await import('node:fs');
    const { join } = await import('node:path');
    // Every face that can construct an LLM/embedding client, not just the CLI — the
    // first pass guarded `src/cli/commands` and left `src/api` and `src/pi` open.
    const roots = ['src/api', 'src/cli/commands', 'src/core', 'src/pi', 'src/utils'];
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) { walk(full); continue; }
        if (!name.endsWith('.ts') || name.includes('.test.')) continue;
        const src = readFileSync(full, 'utf-8');
        const lines = src.split('\n');
        lines.forEach((line, i) => {
          // Any read of the untrusted field, however it is spelled or bound — not just
          // the `?? config.llm?.apiBase` shape the first version matched.
          if (!/\.llm\??\.(apiBase|sslVerify)/.test(line)) return;
          // Clean when the resolver wraps it. The call is often multi-line (the config
          // argument on its own line), so look back a couple of lines for the wrapper.
          const window = lines.slice(Math.max(0, i - 2), i + 1).join('\n');
          if (/resolveTrusted(ApiBase|SslVerify)\s*\(/.test(window)) return;
          offenders.push(`${full}:${i + 1} — ${line.trim().slice(0, 90)}`);
        });
      }
    };
    for (const r of roots) walk(r);
    expect(offenders, `Unguarded repo-config endpoint/TLS reads:\n${offenders.join('\n')}`).toEqual([]);
  });

  /**
   * Sites that legitimately act on a `skipSslVerify` that did NOT come from the repo's
   * config file. Same convention as `tls-coverage.test.ts`'s EXEMPT list: an entry is a
   * claim about provenance, and it must name why.
   */
  const TLS_EXEMPT: ReadonlyArray<{ file: string; why: string }> = [
    {
      file: 'src/core/analyzer/embedding-service.ts',
      why:
        'The EmbeddingService CONSTRUCTOR acts on its EmbeddingConfig argument, which ' +
        'reaches it from `fromEnv` (EMBED_SKIP_SSL_VERIFY — operator-supplied) or from a ' +
        'host process. The one repo-config path, `fromConfig`, passes the value through ' +
        'rejectRepoConfiguredTlsOptOut first, so it can only ever arrive here as false.',
    },
  ];

  it('EmbeddingService.fromConfig still routes its TLS opt-out through the rejecter', async () => {
    // The exemption above is FILE-granular, and that file also contains the one
    // config-fed TLS path in the codebase — so without this positive assertion,
    // reverting `fromConfig` reopens the bypass and the suite stays green.
    const { readFileSync } = await import('node:fs');
    const src = readFileSync('src/core/analyzer/embedding-service.ts', 'utf-8');
    const fromConfig = src.slice(src.indexOf('static fromConfig'));
    const body = fromConfig.slice(0, fromConfig.indexOf('\n  }'));
    expect(body).toMatch(/rejectRepoConfiguredTlsOptOut\(/);
    expect(body).not.toMatch(/skipSslVerify:\s*cfg\.embedding\.skipSslVerify/);
  });

  it('never calls allowInsecureTls on a repo-config `skipSslVerify`', async () => {
    const { readFileSync, readdirSync, statSync } = await import('node:fs');
    const { join } = await import('node:path');
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) { walk(full); continue; }
        if (!name.endsWith('.ts') || name.includes('.test.')) continue;
        if (TLS_EXEMPT.some(e => full.endsWith(e.file))) continue;
        const src = readFileSync(full, 'utf-8');
        // `allowInsecureTls(...)` guarded by, or passed, a skipSslVerify value.
        src.split('\n').forEach((line, i) => {
          if (/allowInsecureTls\s*\(/.test(line) && /skipSslVerify/.test(line)) {
            offenders.push(`${full}:${i + 1} — ${line.trim().slice(0, 90)}`);
          }
          if (/if\s*\(.*skipSslVerify.*\)\s*\{?\s*$/.test(line) && /skipSslVerify/.test(line)
              && !/rejectRepoConfiguredTlsOptOut/.test(line)) {
            offenders.push(`${full}:${i + 1} — ${line.trim().slice(0, 90)}`);
          }
        });
      }
    };
    for (const r of ['src/api', 'src/cli/commands', 'src/core']) walk(r);
    expect(offenders, `Repo-config TLS opt-outs still honoured:\n${offenders.join('\n')}`).toEqual([]);
  });
});
