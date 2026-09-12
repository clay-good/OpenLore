import { describe, expect, it } from 'vitest';
import {
  redactLocalPaths,
  redactSecretText,
  redactSecretTextWithKnownValues,
  redactSecrets,
  redactSecretsWithReport,
} from './secret-redaction.js';

describe('repository secret redaction', () => {
  it('redacts an exact known credential without treating benign config as secret', () => {
    const credential = 'local-test-value';
    const result = redactSecretTextWithKnownValues(
      `model=local-test-model url=https://localhost:11434/v1 echoed=${credential}`,
      [credential],
    );

    expect(result.value).toBe(
      'model=local-test-model url=https://localhost:11434/v1 echoed=[REDACTED:api-key]',
    );
    expect(result.redactions).toEqual({ count: 1, kinds: ['api-key'] });
  });

  it.each([
    ['api-key', 'sk-' + 'a'.repeat(24)],
    ['api-key', 'ghp_' + 'g'.repeat(24)],
    ['api-key', 'sk_live_' + 's'.repeat(24)],
    ['api-key', 'sk-ant-' + 'n'.repeat(24)],
    ['api-key', 'AIza' + 'G'.repeat(35)],
    ['api-key', 'x-api-key: ' + 'x'.repeat(24)],
    ['api-key', 'x-goog-api-key: ' + 'y'.repeat(24)],
    ['api-key', 'https://example.test/generate?key=' + 'k'.repeat(24)],
    ['private-key', '-----BEGIN PRIVATE KEY-----\nZmFrZS1rZXk=\n-----END PRIVATE KEY-----'],
    ['authorization', 'Bearer ' + 'b'.repeat(24)],
    ['authorization', 'Authorization: Basic dXNlcjpzZWNyZXQ='],
    ['authorization', 'HTTP 401: Authorization: Digest username=alice,nonce=abc,response=deadbeef'],
    ['authorization', 'Proxy: {"Authorization":"Basic dXNlcjpzZWNyZXQ=", "Accept":"application/json"}'],
    ['authorization', 'Proxy: { Authorization: "Digest username=alice,nonce=abc,response=deadbeef", Accept: "application/json" }'],
    ['jwt', `eyJ${'a'.repeat(12)}.${'b'.repeat(12)}.${'c'.repeat(12)}`],
    ['connection-string', 'postgres://alice:correct-horse@db.example.test/app'],
    ['cloud-credential', 'AKIA' + 'A1B2C3D4E5F6G7H8'],
    ['cloud-credential', 'AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'],
    ['cloud-credential', 'secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"'],
    ['cloud-credential', 'AWS_SESSION_TOKEN=' + 't'.repeat(32)],
  ])('redacts a %s with a typed marker and receipt', (kind, secret) => {
    const result = redactSecretText(secret);
    expect(result.value).not.toContain(secret);
    expect(result.value).toContain(`[REDACTED:${kind}]`);
    expect(result.redactions).toEqual({ count: 1, kinds: [kind] });
  });

  it('redacts secret-named fields and nested source strings in one report', () => {
    const result = redactSecretsWithReport({
      apiKey: 'unstructured-but-secret',
      body: `const token = "${'z'.repeat(24)}";`,
    });

    expect(result.value).toEqual({
      apiKey: '[REDACTED:secret-field]',
      body: 'const token = [REDACTED:secret-field];',
    });
    expect(result.redactions).toEqual({ count: 2, kinds: ['secret-field'] });
  });

  it('classifies AWS SDK credential fields as cloud credentials', () => {
    const result = redactSecretsWithReport({
      awsSecretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      sessionToken: 'temporary-session-token-value',
    });

    expect(result.value).toEqual({
      awsSecretAccessKey: '[REDACTED:cloud-credential]',
      sessionToken: '[REDACTED:cloud-credential]',
    });
    expect(result.redactions).toEqual({ count: 2, kinds: ['cloud-credential'] });
  });

  it.each([
    'buildArtifactIdentifier',
    '550e8400-e29b-41d4-a716-446655440000',
    '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    'const token = process.env.API_TOKEN;',
    'const token = getToken();',
    'const token = cachedToken;',
    'const token = undefined;',
    '{ Authorization: token, Accept: "application/json" }',
  ])('does not redact non-secret identifiers and hashes: %s', (value) => {
    expect(redactSecretText(value)).toEqual({
      value,
      redactions: { count: 0, kinds: [] },
    });
  });
});

describe('gaps closed by the red-team pass', () => {
  it('redacts a user:pass@ URL on a scheme the enumeration never listed', () => {
    const result = redactSecretText('gateway https://svc:S3cr3tPw@internal/api refused');
    expect(result.value).not.toContain('S3cr3tPw');
    expect(result.redactions.kinds).toContain('connection-string');
  });

  it('redacts a NON-string value under a secret-named key', () => {
    // `{"apiKey":{"value":"…"}}` is an ordinary shape for a credential read out of a
    // config or echoed by a provider; the string-only test walked straight past the key
    // and left the nested value to the pattern matcher, which a short key escapes.
    expect(redactSecrets({ apiKey: { value: 'short' } })).toEqual({ apiKey: '[REDACTED]' });
    expect(redactSecrets({ token: ['a', 'b'] })).toEqual({ token: '[REDACTED]' });
    expect(redactSecretsWithReport({ apiKey: { value: 'short' } }).value)
      .toEqual({ apiKey: '[REDACTED:secret-field]' });
  });

  it('leaves a null/undefined secret field alone (it invents no credential)', () => {
    expect(redactSecrets({ apiKey: null })).toEqual({ apiKey: null });
    expect(redactSecretsWithReport({ apiKey: null }).redactions.count).toBe(0);
  });

  it.each(['auth', 'pat', 'webhook', 'webhookUrl', 'signingKey', 'cookie', 'sessionId'])(
    'treats %s as a secret key name',
    (key) => {
      expect(redactSecrets({ [key]: 'value-here' })).toEqual({ [key]: '[REDACTED]' });
    },
  );

  it('does not redact keys that merely contain a secret word', () => {
    expect(redactSecrets({ tokenBudget: 600, pathPrefix: 'src' }))
      .toEqual({ tokenBudget: 600, pathPrefix: 'src' });
  });

  it('redacts absolute filesystem paths only through the explicit path helper', () => {
    // Paths are disclosure, not credentials: they must not inflate a redaction receipt.
    expect(redactSecretText('/Users/alice/project/foo.ts').redactions.count).toBe(0);
    expect(redactLocalPaths('/Users/alice/project/foo.ts')).toBe('[path]');
    expect(redactLocalPaths('/home/deploy/app')).toBe('[path]');
    expect(redactLocalPaths('C:\\Users\\bob\\file.ts')).toBe('[path]');
  });
});
