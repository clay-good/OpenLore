/**
 * Optional feature dependencies (change: extend-api-for-supervising-hosts,
 * cli: OptionalFeatureDependenciesDegradeAtTheirOwnCommand).
 *
 * The property under test is the MESSAGE, not the loading. An absent optional package is an
 * installer choice, so what reaches the user has to be the package name and the line that fixes it
 * — never a raw `ERR_MODULE_NOT_FOUND` stack, which reads as a corrupt installation and names no
 * remedy. The inverse matters just as much: a package that IS installed but throws while loading is
 * a real fault, and reporting it as "not installed" would send the user to reinstall what they have.
 */
import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  installCommandFor,
  loadMcpSdk,
  loadOptionalFeature,
  loadViewerToolchain,
  MCP_SDK_ALTERNATIVE,
  MCP_SDK_PACKAGES,
  OptionalFeatureError,
  VIEWER_PACKAGES,
} from './optional-features.js';

/** A resolution failure exactly as Node reports an uninstalled package. */
function moduleNotFound(specifier: string): Error {
  const error = new Error(`Cannot find package '${specifier}'`) as NodeJS.ErrnoException;
  error.code = 'ERR_MODULE_NOT_FOUND';
  return error;
}

describe('optional feature loaders', () => {
  it('reports an absent viewer toolchain as an uninstalled feature with its install command', async () => {
    const error = await loadOptionalFeature(
      () => Promise.reject(moduleNotFound('vite')),
      'The graph viewer (`openlore view`)',
      VIEWER_PACKAGES,
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(OptionalFeatureError);
    const message = (error as Error).message;
    for (const pkg of VIEWER_PACKAGES) expect(message).toContain(pkg);
    expect(message).toContain(installCommandFor(VIEWER_PACKAGES));
    expect(message).toContain('not a broken installation');
    // The raw resolution error never reaches the user.
    expect(message).not.toContain('ERR_MODULE_NOT_FOUND');
    expect(message).not.toContain('Cannot find package');
    expect((error as OptionalFeatureError).packages).toEqual([...VIEWER_PACKAGES]);
  });

  it('reports an absent stdio SDK and names the HTTP daemon as the alternative transport', async () => {
    const error = await loadOptionalFeature(
      () => Promise.reject(moduleNotFound('@modelcontextprotocol/sdk/server/index.js')),
      'The stdio MCP server (`openlore mcp`)',
      MCP_SDK_PACKAGES,
      MCP_SDK_ALTERNATIVE,
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(OptionalFeatureError);
    const message = (error as Error).message;
    expect(message).toContain('@modelcontextprotocol/sdk');
    expect(message).toContain(installCommandFor(MCP_SDK_PACKAGES));
    expect(message).toContain('openlore serve');
    expect(message).not.toContain('ERR_MODULE_NOT_FOUND');
  });

  it('rethrows a real load failure instead of blaming the installation', async () => {
    const error = await loadOptionalFeature(
      () => Promise.reject(new Error('vite threw while initializing')),
      'The graph viewer (`openlore view`)',
      VIEWER_PACKAGES,
    ).catch((e: unknown) => e);

    expect(error).not.toBeInstanceOf(OptionalFeatureError);
    expect((error as Error).message).toBe('vite threw while initializing');
  });

  it('loads both features when their packages are installed', async () => {
    const [viewer, sdk] = await Promise.all([loadViewerToolchain(), loadMcpSdk()]);
    expect(typeof viewer.createServer).toBe('function');
    expect(typeof viewer.react).toBe('function');
    expect(typeof sdk.Server).toBe('function');
    expect(typeof sdk.StdioServerTransport).toBe('function');
    expect(sdk.types.LATEST_PROTOCOL_VERSION).toBeTypeOf('string');
  });
});

describe('optional dependency placement', () => {
  it('declares the viewer toolchain and the stdio SDK as optional, and ships no unreferenced package', async () => {
    const pkg = JSON.parse(await readFile(new URL('../../../package.json', import.meta.url), 'utf8')) as {
      dependencies: Record<string, string>;
      optionalDependencies: Record<string, string>;
    };
    for (const name of [...VIEWER_PACKAGES, ...MCP_SDK_PACKAGES]) {
      expect(pkg.optionalDependencies, `${name} must be optional`).toHaveProperty(name);
      expect(pkg.dependencies).not.toHaveProperty(name);
    }
    // The dead package this audit exists for.
    expect(pkg.dependencies).not.toHaveProperty('@modelcontextprotocol/server-memory');
    expect(pkg.optionalDependencies).not.toHaveProperty('@modelcontextprotocol/server-memory');
  });

  it('keeps only imported packages in dependencies, and fails when an unused one returns', async () => {
    const audit = await import('../../../scripts/audit-dependencies.mjs') as {
      findUnreferencedDependencies: (deps: string[], sources: string[]) => string[];
      collectSources: (dir: string) => string[];
    };
    const pkg = JSON.parse(await readFile(new URL('../../../package.json', import.meta.url), 'utf8')) as {
      dependencies: Record<string, string>;
    };
    // `fileURLToPath`, not `.pathname`: on Windows a file URL's pathname is `/D:/a/...`, and
    // `readdirSync` resolves that leading slash against the current drive — the observed failure
    // was `scandir 'D:\D:\a\OpenLore\OpenLore\src\'`.
    const srcDir = fileURLToPath(new URL('../../', import.meta.url));
    const sources = await Promise.all(audit.collectSources(srcDir).map(file => readFile(file, 'utf8')));

    expect(audit.findUnreferencedDependencies(Object.keys(pkg.dependencies), sources)).toEqual([]);
    // Reintroducing the dead package is exactly what this must catch.
    expect(audit.findUnreferencedDependencies(
      [...Object.keys(pkg.dependencies), '@modelcontextprotocol/server-memory'],
      sources,
    )).toEqual(['@modelcontextprotocol/server-memory']);
  });
});
