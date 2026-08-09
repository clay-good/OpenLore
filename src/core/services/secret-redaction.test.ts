import { describe, expect, it } from 'vitest';
import { redactSecretText, redactSecretsWithReport } from './secret-redaction.js';

describe('repository secret redaction', () => {
  it.each([
    ['api-key', 'sk-' + 'a'.repeat(24)],
    ['private-key', '-----BEGIN PRIVATE KEY-----\nZmFrZS1rZXk=\n-----END PRIVATE KEY-----'],
    ['authorization', 'Bearer ' + 'b'.repeat(24)],
    ['jwt', `eyJ${'a'.repeat(12)}.${'b'.repeat(12)}.${'c'.repeat(12)}`],
    ['connection-string', 'postgres://alice:correct-horse@db.example.test/app'],
    ['cloud-credential', 'AKIA' + 'A1B2C3D4E5F6G7H8'],
  ])('redacts a %s with a typed marker and receipt', (kind, secret) => {
    const result = redactSecretText(`before ${secret} after`);
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

  it.each([
    'buildArtifactIdentifier',
    '550e8400-e29b-41d4-a716-446655440000',
    '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  ])('does not redact non-secret identifiers and hashes: %s', (value) => {
    expect(redactSecretText(value)).toEqual({
      value,
      redactions: { count: 0, kinds: [] },
    });
  });
});
