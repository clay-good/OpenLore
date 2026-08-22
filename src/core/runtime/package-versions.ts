import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';

const packageRequire = createRequire(import.meta.url);
export const OPENLORE_PACKAGE_VERSION = (packageRequire('../../../package.json') as { version: string }).version;

/** Resolve the OpenSpec CLI package visible to the analyzed project or OpenLore itself. */
export async function detectOpenSpecPackageVersion(rootPath: string): Promise<string> {
  const resolvers = [createRequire(join(resolve(rootPath), 'package.json')), packageRequire];
  for (const resolver of resolvers) {
    for (const name of ['@fission-ai/openspec', 'openspec']) {
      try {
        const entry = resolver.resolve(name);
        const packagePath = join(dirname(dirname(entry)), 'package.json');
        const parsed = resolver(packagePath) as { version?: unknown };
        if (typeof parsed.version === 'string' && parsed.version.length > 0) return parsed.version;
      } catch {
        // Try the next package/resolution scope.
      }
    }
  }
  return 'unknown';
}
