import { describe, it, expect } from 'vitest';
import {
  deriveDomainFromPath,
  deriveDomainOwnershipFromPath,
  isTechnicalDomainRole,
  DOMAIN_NOISE_DIRS,
} from './domain-naming.js';

describe('deriveDomainFromPath', () => {
  it('returns the leaf business package for a Maven/Gradle Java layout', () => {
    // Regression for #138: must NOT collapse to the reverse-DNS org root.
    expect(
      deriveDomainFromPath('src/main/java/com/example/inventory'.split('/'))
    ).toBe('inventory');
    expect(
      deriveDomainFromPath('src/main/java/org/springframework/samples/petclinic/owner'.split('/'))
    ).toBe('owner');
  });

  it('does not surface the org/company root (com/org/io) as a domain', () => {
    // The bug: root-first walking grabbed "com"/"org"/"springframework".
    const domain = deriveDomainFromPath(
      'src/main/java/org/springframework/samples/petclinic/vet'.split('/')
    );
    expect(domain).toBe('vet');
    expect(domain).not.toBe('springframework');
    expect(domain).not.toBe('org');
  });

  it('skips build-layout noise (main/java/kotlin/resources)', () => {
    expect(deriveDomainFromPath('src/main/kotlin/billing'.split('/'))).toBe('billing');
    expect(deriveDomainFromPath('src/main/resources/db'.split('/'))).toBe('db');
  });

  it('skips Go build-layout noise (pkg/internal/cmd)', () => {
    expect(deriveDomainFromPath('pkg/internal/scheduler'.split('/'))).toBe('scheduler');
  });

  it('applies canonical role names for well-known directories', () => {
    expect(deriveDomainFromPath('src/services'.split('/'))).toBe('services');
    expect(deriveDomainFromPath('src/main/java/com/acme/model'.split('/'))).toBe('domain');
    expect(deriveDomainFromPath('app/utils'.split('/'))).toBe('utilities');
  });

  it('returns null when the path is nothing but noise', () => {
    expect(deriveDomainFromPath('src/main/java/com'.split('/'))).toBeNull();
    expect(deriveDomainFromPath([])).toBeNull();
    expect(deriveDomainFromPath(['(root)'])).toBeNull();
  });

  it('ignores dotfile directory segments', () => {
    expect(deriveDomainFromPath('.github/workflows'.split('/'))).toBe('workflows');
  });

  it('exposes the reverse-DNS package roots as noise', () => {
    for (const d of ['com', 'org', 'io', 'net', 'main', 'java', 'src']) {
      expect(DOMAIN_NOISE_DIRS.has(d)).toBe(true);
    }
  });
});

describe('deriveDomainOwnershipFromPath', () => {
  it('uses the stable module root for TypeScript implementation children', () => {
    expect(deriveDomainOwnershipFromPath('src/core/generator/stages'.split('/'), '.ts')).toBe('generator');
    expect(deriveDomainOwnershipFromPath('src/cli/commands'.split('/'), '.ts')).toBe('cli');
  });

  it('uses the workspace package as the owner', () => {
    expect(deriveDomainOwnershipFromPath('packages/payments/src/services'.split('/'), '.ts')).toBe('payments');
  });

  it('preserves leaf package ownership for JVM layouts', () => {
    expect(deriveDomainOwnershipFromPath(
      'src/main/java/org/example/petclinic/owner'.split('/'), '.java',
    )).toBe('owner');
    expect(deriveDomainOwnershipFromPath(
      'src/main/kotlin/org/example/petclinic/vet'.split('/'), '.kt',
    )).toBe('vet');
  });

  it('selects layout per tree in a mixed repository', () => {
    expect(deriveDomainOwnershipFromPath('packages/web/src/components'.split('/'), '.tsx')).toBe('web');
    expect(deriveDomainOwnershipFromPath('backend/src/main/java/org/acme/orders'.split('/'), '.java')).toBe('orders');
    expect(deriveDomainOwnershipFromPath('backend/src/main/kotlin/org/acme/billing'.split('/'), 'kt')).toBe('billing');
  });

  it('treats technical names as reconciliation signals, not path noise', () => {
    expect(isTechnicalDomainRole('stages')).toBe(true);
    expect(isTechnicalDomainRole('commands')).toBe(true);
    expect([
      'api', 'routes', 'endpoint', 'endpoints',
      'model', 'entities', 'entity', 'schema', 'schemas',
      'dto', 'dtos', 'component', 'hooks',
      'resource', 'repos', 'repository', 'dao',
    ].every(isTechnicalDomainRole)).toBe(true);
    expect(isTechnicalDomainRole('payments')).toBe(false);
    expect(DOMAIN_NOISE_DIRS.has('stages')).toBe(false);
  });
});
