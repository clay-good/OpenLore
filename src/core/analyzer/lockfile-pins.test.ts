/**
 * Lockfile pin readers (change: add-phantom-reference-findings): each ecosystem's real format, and
 * the refusal to answer for a file this reader does not understand — "pins nothing" and "could not
 * be read" lead to opposite conclusions, so they must never collapse into one another.
 */
import { describe, it, expect } from 'vitest';
import { normalizePackageName, pinnedNames, pinsPackage, ECOSYSTEM_LOCKFILES } from './lockfile-pins.js';

describe('pinnedNames', () => {
  it('reads a v3 package-lock tree, including nested and scoped packages', () => {
    const text = JSON.stringify({
      lockfileVersion: 3,
      packages: {
        '': { name: 'app' },
        'node_modules/lodash': { version: '4.17.21' },
        'node_modules/@scope/pkg': { version: '1.0.0' },
        'node_modules/a/node_modules/b': { version: '2.0.0' },
      },
    });
    expect([...pinnedNames('package-lock.json', text)!].sort()).toEqual(['@scope/pkg', 'b', 'lodash']);
  });

  it('reads a v1 package-lock dependency tree', () => {
    const text = JSON.stringify({
      lockfileVersion: 1,
      dependencies: { lodash: { version: '4.17.21', dependencies: { inner: { version: '1.0.0' } } } },
    });
    expect([...pinnedNames('package-lock.json', text)!].sort()).toEqual(['inner', 'lodash']);
  });

  it('reads pnpm packages and v9 snapshots, dropping version and peer suffixes', () => {
    const v6 = 'lockfileVersion: 6.0\npackages:\n  /lodash@4.17.21:\n    resolution: {integrity: sha512-x}\n  /@scope/pkg@1.0.0:\n    resolution: {integrity: sha512-y}\n';
    expect([...pinnedNames('pnpm-lock.yaml', v6)!].sort()).toEqual(['@scope/pkg', 'lodash']);
    const v9 = "lockfileVersion: '9.0'\nsnapshots:\n  vite@5.0.0(@types/node@20.0.0):\n    dependencies: {}\n";
    expect([...pinnedNames('pnpm-lock.yaml', v9)!]).toEqual(['vite']);
  });

  it('reads a yarn classic and a berry lockfile', () => {
    const classic = '# yarn lockfile v1\n\n\n"@scope/pkg@^1.0.0":\n  version "1.0.0"\n\nlodash@^4.0.0, lodash@^4.17.0:\n  version "4.17.21"\n';
    expect([...pinnedNames('yarn.lock', classic)!].sort()).toEqual(['@scope/pkg', 'lodash']);
    const berry = '__metadata:\n  version: 8\n\n"lodash@npm:4.17.21":\n  version: 4.17.21\n';
    expect([...pinnedNames('yarn.lock', berry)!]).toEqual(['lodash']);
  });

  it('reads TOML package blocks and ignores other sections', () => {
    const text = '[[package]]\nname = "serde"\nversion = "1.0"\n\n[metadata]\nname = "not-a-package"\n\n[[package]]\nname = "tokio"\n';
    expect([...pinnedNames('Cargo.lock', text)!].sort()).toEqual(['serde', 'tokio']);
    expect([...pinnedNames('poetry.lock', '[[package]]\nname = "requests"\n')!]).toEqual(['requests']);
  });

  it('reads a Pipfile.lock', () => {
    const text = JSON.stringify({ default: { requests: { version: '==2.0' } }, develop: { pytest: {} } });
    expect([...pinnedNames('Pipfile.lock', text)!].sort()).toEqual(['pytest', 'requests']);
  });

  it('reads go.sum module paths once', () => {
    const text = 'github.com/pkg/errors v0.9.1 h1:abc=\ngithub.com/pkg/errors v0.9.1/go.mod h1:def=\n';
    expect([...pinnedNames('go.sum', text)!]).toEqual(['github.com/pkg/errors']);
  });

  it('refuses to answer for an unknown name, malformed content, or the wrong format', () => {
    expect(pinnedNames('unknown.lock', 'anything')).toBeNull();
    expect(pinnedNames('package-lock.json', '{ not json')).toBeNull();
    expect(pinnedNames('package-lock.json', '{"lockfileVersion":3}')).toBeNull();
    expect(pinnedNames('pnpm-lock.yaml', '\t: bad yaml:\n  - [')).toBeNull();
    expect(pinnedNames('Cargo.lock', '# empty\n')).toBeNull();
    expect(pinnedNames('go.sum', 'this is not a go.sum line at all\n')).toBeNull();
    expect(pinnedNames('yarn.lock', '# only a comment\n')).toBeNull();
  });

  it('reports an empty pin set for a lockfile that genuinely pins nothing', () => {
    // An npm workspace lockfile with only the root entry pins no dependency — a real answer, not a refusal.
    const text = JSON.stringify({ lockfileVersion: 3, packages: { '': { name: 'app' } } });
    expect(pinnedNames('package-lock.json', text)).toEqual(new Set());
  });
});

describe('name comparison', () => {
  it('compares Python names by PEP 503 normalization and Cargo names across dash and underscore', () => {
    expect(normalizePackageName('pypi', 'Flask_SQLAlchemy')).toBe(normalizePackageName('pypi', 'flask-sqlalchemy'));
    expect(normalizePackageName('cargo', 'serde_json')).toBe(normalizePackageName('cargo', 'serde-json'));
    expect(normalizePackageName('npm', 'Lodash')).toBe('Lodash');
  });

  it('matches a Go import path against the module prefix the lockfile pins', () => {
    const pins = new Set(['github.com/pkg/errors']);
    expect(pinsPackage('go', pins, 'github.com/pkg/errors/sub')).toBe(true);
    expect(pinsPackage('go', pins, 'github.com/pkg/errorsx')).toBe(false);
  });

  it('matches other ecosystems by exact normalized name, never by prefix', () => {
    expect(pinsPackage('npm', new Set(['lodash']), 'lodash')).toBe(true);
    expect(pinsPackage('npm', new Set(['lodash']), 'lodash-es')).toBe(false);
  });

  it('pairs every ecosystem with at least one lockfile name', () => {
    for (const [ecosystem, names] of Object.entries(ECOSYSTEM_LOCKFILES)) {
      expect(names.length, ecosystem).toBeGreaterThan(0);
    }
  });
});
