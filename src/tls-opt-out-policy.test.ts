/**
 * Policy guard for the operator TLS opt-out surface.
 *
 * Covers spec `config` / TlsOptOutVariablesAreSurfaceScopedAndDocumented: each network
 * surface gets its own variable, there is deliberately NO variable that relaxes both, and
 * the certificate-authority alternative that is preferred over either is documented
 * alongside them.
 *
 * A doc-and-source policy test rather than a behavioural one, in the same spirit as
 * `llm-log-policy.test.ts`: the requirement is about what the configuration surface
 * OFFERS and documents, which no runtime assertion can observe.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const read = (p: string) => readFileSync(join(root, p), 'utf-8');

describe('TLS opt-out surface policy', () => {
  const tlsScope = read('src/core/services/tls-scope.ts');
  const configDoc = read('docs/configuration.md');

  it('exposes exactly one opt-out variable per surface', () => {
    expect(tlsScope).toContain("EMBED_TLS_ENV = 'EMBED_SKIP_SSL_VERIFY'");
    expect(tlsScope).toContain("LLM_TLS_ENV = 'LLM_SKIP_SSL_VERIFY'");
  });

  it('offers no variable that relaxes both surfaces at once', () => {
    // A union key is the one thing this design refuses: relaxing one surface must never
    // relax the other. Guarded by name so a future re-introduction is deliberate.
    expect(tlsScope).not.toMatch(/OPENLORE_INSECURE_TLS|OPENLORE_SKIP_SSL/);
    for (const file of [
      'src/core/services/repo-config-trust.ts',
      'src/core/services/llm-service.ts',
      'src/core/analyzer/embedding-service.ts',
      'src/cli/commands/doctor.ts',
    ]) {
      expect(read(file)).not.toMatch(/OPENLORE_INSECURE_TLS|OPENLORE_SKIP_SSL/);
    }
  });

  it('documents both variables and the preferred certificate-authority alternative', () => {
    expect(configDoc).toContain('`EMBED_SKIP_SSL_VERIFY`');
    expect(configDoc).toContain('`LLM_SKIP_SSL_VERIFY`');
    expect(configDoc).toContain('`NODE_EXTRA_CA_CERTS`');
    expect(configDoc).toContain('### Self-signed certificates');
  });

  it('documents each skip variable as scoped to its own surface', () => {
    const embedRow = configDoc.split('\n').find(l => l.includes('`EMBED_SKIP_SSL_VERIFY`'))!;
    const llmRow = configDoc.split('\n').find(l => l.includes('`LLM_SKIP_SSL_VERIFY`'))!;
    expect(embedRow).toMatch(/embedding/i);
    expect(embedRow).toMatch(/only/i);
    expect(llmRow).toMatch(/LLM/);
    expect(llmRow).toMatch(/only/i);
  });

  it('keeps the cross-references from the embedding and provider docs resolvable', () => {
    for (const doc of ['docs/providers.md', 'docs/semantic-search.md']) {
      expect(read(doc)).toContain('configuration.md#self-signed-certificates');
    }
  });
});
