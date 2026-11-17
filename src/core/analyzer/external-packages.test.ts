/**
 * Manifest readers (change: add-phantom-reference-findings). What counts as DECLARED decides whether
 * an import is reported as undeclared, so each section a real manifest uses is pinned here, as is
 * the distribution name a repository builds (importing that is importing itself).
 */
import { describe, it, expect } from 'vitest';
import {
  parseCargoManifest, parseGoModManifest, parseNpmManifest, parsePyprojectManifest,
  parsePyprojectName, parseRequirementsManifest, tomlSection,
} from './external-packages.js';

const names = (packages: Array<{ name: string }>) => packages.map(p => p.name).sort();

describe('package.json', () => {
  it('reads every dependency section, including optional ones', () => {
    const text = JSON.stringify({
      dependencies: { a: '1' }, devDependencies: { b: '1' },
      peerDependencies: { c: '1' }, optionalDependencies: { d: '1' },
    });
    expect(names(parseNpmManifest(text))).toEqual(['a', 'b', 'c', 'd']);
  });

  it('throws on malformed JSON, so a caller can tell it from a manifest that declares nothing', () => {
    expect(() => parseNpmManifest('{ not json')).toThrow();
    expect(parseNpmManifest('{}')).toEqual([]);
  });
});

describe('pyproject.toml', () => {
  const manifest = [
    '[project]', 'name = "my-dist"  # the distribution', 'dependencies = ["requests>=2.0"]', '',
    '[project.optional-dependencies]  # extras', 'extra = [', '  "httpx>=0.27",', ']', '',
    '[dependency-groups]', 'lint = ["ruff>=0.5"]', 'dev = [{include-group = "lint"}, "pytest>=8"]', '',
    '[tool.poetry.dependencies]', 'python = "^3.11"', 'click = "^8.0"', '',
  ].join('\n');

  it('reads PEP 621 dependencies, extras, PEP 735 groups, and Poetry sections', () => {
    expect(names(parsePyprojectManifest(manifest))).toEqual(['click', 'httpx', 'pytest', 'requests', 'ruff']);
  });

  it('does not read an include-group reference or the python constraint as a package', () => {
    const declared = names(parsePyprojectManifest(manifest));
    expect(declared).not.toContain('lint');
    expect(declared).not.toContain('python');
  });

  it('reads the distribution name from PEP 621 or Poetry', () => {
    expect(parsePyprojectName(manifest)).toBe('my-dist');
    expect(parsePyprojectName('[tool.poetry]\nname = "poetry-dist"\n')).toBe('poetry-dist');
    expect(parsePyprojectName('[project]\ndescription = "no name here"\n')).toBeNull();
    expect(parsePyprojectName('[project]\r\nname = "crlf-dist"\r\n')).toBe('crlf-dist');
  });
});

describe('tomlSection', () => {
  it('ends a section at the next table header, not at an array that starts a line', () => {
    const raw = '[a]\nkey =\n  [ "v" ]\nother = "x"\n\n[[b]]\nname = "nope"\n';
    expect(tomlSection(raw, 'a')).toContain('"v"');
    expect(tomlSection(raw, 'a')).toContain('other');
    expect(tomlSection(raw, 'a')).not.toContain('nope');
  });

  it('matches a header carrying a trailing comment, and returns nothing for an absent one', () => {
    expect(tomlSection('[a] # note\nk = 1\n', 'a')).toContain('k = 1');
    expect(tomlSection('[a]\nk = 1\n', 'b')).toBe('');
  });
});

describe('other ecosystems', () => {
  it('reads requirements, Cargo sections, and go.mod requires', () => {
    expect(names(parseRequirementsManifest('# c\nrequests>=2.0\n-e .\nflask\n'))).toEqual(['flask', 'requests']);
    const cargo = '[dependencies]\nserde = "1.0"\ntokio = { version = "1", features = ["full"] }\ninherited = { workspace = true }\n\n[build-dependencies]\ncc = "1.0"\n';
    expect(names(parseCargoManifest(cargo))).toEqual(['cc', 'inherited', 'serde', 'tokio']);
    expect(names(parseGoModManifest('module x\n\nrequire (\n\tgithub.com/a/b v1.0.0\n)\n\nrequire github.com/c/d v2.0.0\n')))
      .toEqual(['github.com/a/b', 'github.com/c/d']);
  });
});

describe('round-5 regressions', () => {
  it('does not let a bracket inside a string or a column-0 comment swallow the next table', () => {
    const raw = [
      '[dependencies]', 'path_hint = "a[b"', '# TODO set a =', 'serde = "1.0"', '',
      '[dev-dependencies]', 'criterion = "0.5"', '',
    ].join('\n');
    expect(tomlSection(raw, 'dependencies')).not.toContain('criterion');
    const declared = parseCargoManifest(raw);
    expect(declared.filter(p => p.name === 'criterion')).toHaveLength(1);
    expect(names(declared)).toEqual(['criterion', 'path_hint', 'serde']);
  });
});
