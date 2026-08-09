import { describe, expect, it } from 'vitest';
import { redactSecretText, redactSecretsWithReport } from './secret-redaction.js';

describe('repository secret redaction', () => {
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
