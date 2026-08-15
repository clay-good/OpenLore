/**
 * Domain naming
 *
 * Single source of truth for turning a file path into a business-domain
 * name. Used by both the dependency-graph cluster naming (`suggestDomainName`)
 * and the repository-mapper domain inference (`inferDomains`) so the two never
 * diverge — a divergence that previously made Java/Kotlin projects collapse all
 * source into a reverse-DNS org root like "springframework" (issue #138).
 */

import type { ScoredFile } from '../../types/index.js';

export type DomainFileRole = 'defining' | 'supporting' | 'excluded';
export type DomainFileRoleReason =
  | 'production-source'
  | 'test-file'
  | 'config-file'
  | 'generated-file'
  | 'tooling-file'
  | 'fixture-tree';

export interface DomainFileClassification {
  role: DomainFileRole;
  reason: DomainFileRoleReason;
}

const DOMAIN_ALWAYS_EXCLUDED_TREE_SEGMENTS = new Set([
  '__fixtures__', '__snapshots__', 'fixtures', 'snapshots',
  'vendor', 'node_modules', 'dist', 'coverage',
]);

/**
 * Directory segments that should never be used as a domain name when deriving
 * one from a path. Covers generic source roots plus language build layouts
 * (Maven/Gradle `src/main/java`, Go `pkg`/`internal`) and reverse-DNS package
 * roots (`com`, `org`, `io`, …) so that Java/Kotlin/Go projects don't get
 * nonsense domains like "main", "java", "com", or "springframework".
 */
export const DOMAIN_NOISE_DIRS = new Set([
  'src', 'lib', 'app', 'apps', 'source', 'sources',
  'main', 'java', 'kotlin', 'scala', 'groovy', 'resources',
  'test', 'tests', 'spec', 'specs', '__tests__',
  'target', 'build', 'out', 'dist', 'bin', 'obj', 'gen', 'generated',
  'pkg', 'internal', 'cmd', 'node_modules', 'vendor',
  'com', 'org', 'io', 'net', 'gov', 'edu', 'co',
]);

/**
 * Directory roles are candidate evidence, never a denylist. A nested candidate
 * with one of these exact names needs an independent boundary to survive
 * reconciliation; a top-level owner with the same name remains valid.
 */
export const DOMAIN_TECHNICAL_ROLES = new Set([
  'adapters', 'api', 'commands', 'components', 'config', 'controllers',
  'domain', 'dto', 'handlers', 'hooks', 'middleware', 'repositories',
  'services', 'shared', 'stages', 'utilities',
]);

const PACKAGE_LAYOUT_EXTENSIONS = new Set([
  '.java', '.kt', '.kts', '.scala', '.groovy',
]);

const MODULE_CONTAINER_DIRS = new Set(['packages', 'apps']);
const OPTIONAL_MODULE_WRAPPERS = new Set(['core']);

/**
 * Canonical names for common directory roles. The first matching pattern wins;
 * an empty replacement means "fall back to the segment's own lowercased name".
 */
const DOMAIN_PATTERNS: [RegExp, string][] = [
  [/^src$/i, ''],
  [/^lib$/i, ''],
  [/^app$/i, ''],
  [/^(api|routes|endpoints?)$/i, 'api'],
  [/^(models?|entities|entity|schemas?|domain)$/i, 'domain'],
  [/^(services?)$/i, 'services'],
  [/^(controllers?|resources?)$/i, 'controllers'],
  [/^(repositor(y|ies)|repos?|dao|daos)$/i, 'repositories'],
  [/^(handlers?)$/i, 'handlers'],
  [/^(middlewares?)$/i, 'middleware'],
  [/^(utils?|helpers?|common)$/i, 'utilities'],
  [/^(components?)$/i, 'components'],
  [/^(hooks?)$/i, 'hooks'],
  [/^(config|configuration|settings)$/i, 'config'],
  [/^(dto|dtos)$/i, 'dto'],
  [/^(auth|authentication)$/i, 'authentication'],
  [/^(users?)$/i, 'users'],
  [/^(products?)$/i, 'products'],
  [/^(orders?)$/i, 'orders'],
  [/^(payments?)$/i, 'payments'],
  [/^(core)$/i, 'core'],
];

/**
 * Derive a business-domain name from a directory's path segments by walking
 * from the deepest (most specific) segment outward, skipping build-layout and
 * reverse-DNS package noise. Returns null when no meaningful segment exists
 * (e.g. a file sitting directly in a noise root), letting the caller fall back.
 *
 * `src/main/java/com/example/inventory` → `inventory`
 * `org/springframework/samples/petclinic/owner` → `owner`
 */
export function deriveDomainFromPath(dirParts: string[]): string | null {
  for (let i = dirParts.length - 1; i >= 0; i--) {
    const part = dirParts[i];
    if (!part || part === '(root)' || part.startsWith('.')) continue;
    if (DOMAIN_NOISE_DIRS.has(part.toLowerCase())) continue;
    for (const [pattern, replacement] of DOMAIN_PATTERNS) {
      if (pattern.test(part)) {
        return replacement || part.toLowerCase();
      }
    }
    return part.toLowerCase().replace(/[^a-z0-9]/g, '-');
  }
  return null;
}

/**
 * Select a stable ownership root for one source tree. Package-oriented JVM
 * layouts keep the leaf-business-package behaviour; module-oriented trees use
 * the first meaningful segment below their source root (and optional `core`
 * wrapper), so implementation children do not become sibling domains.
 */
export function deriveDomainOwnershipFromPath(
  dirParts: string[],
  extension = '',
): string | null {
  const normalizedExtension = extension.startsWith('.') ? extension.toLowerCase() : `.${extension.toLowerCase()}`;
  const packageLayout = dirParts.some(part =>
    ['java', 'kotlin', 'scala', 'groovy'].includes(part.toLowerCase()));
  if (PACKAGE_LAYOUT_EXTENSIONS.has(normalizedExtension) || packageLayout) {
    return deriveDomainFromPath(dirParts);
  }

  const parts = dirParts.filter(part => part && part !== '(root)' && !part.startsWith('.'));
  if (parts.length === 0) return null;

  const first = parts[0].toLowerCase();
  if (MODULE_CONTAINER_DIRS.has(first) && parts[1]) {
    return normalizeDomainSegment(parts[1]);
  }

  const sourceRoot = parts.findIndex(part =>
    ['src', 'lib', 'app', 'source', 'sources'].includes(part.toLowerCase()));
  const afterRoot = sourceRoot >= 0 ? parts.slice(sourceRoot + 1) : parts;
  const meaningful = afterRoot.filter(part => {
    const lower = part.toLowerCase();
    return !DOMAIN_NOISE_DIRS.has(lower) && !OPTIONAL_MODULE_WRAPPERS.has(lower);
  });
  return meaningful.length > 0 ? normalizeDomainSegment(meaningful[0]) : null;
}

/** True when a nested candidate name denotes an architectural role. */
export function isTechnicalDomainRole(name: string): boolean {
  return DOMAIN_TECHNICAL_ROLES.has(normalizeDomainSegment(name));
}

/** Classify whether an analyzed file may define, only support, or never affect a domain. */
export function classifyDomainFile(file: ScoredFile): DomainFileClassification {
  const segments = file.path.replace(/\\/g, '/').split('/').map(segment => segment.toLowerCase());
  if (file.tooling) return { role: 'excluded', reason: 'tooling-file' };
  if (file.isGenerated) return { role: 'excluded', reason: 'generated-file' };
  if (isFixtureOrSampleTree(segments)) {
    return { role: 'excluded', reason: 'fixture-tree' };
  }
  if (file.isTest) return { role: 'supporting', reason: 'test-file' };
  if (file.isConfig) return { role: 'excluded', reason: 'config-file' };
  return { role: 'defining', reason: 'production-source' };
}

function isFixtureOrSampleTree(segments: string[]): boolean {
  if (segments.some(segment => DOMAIN_ALWAYS_EXCLUDED_TREE_SEGMENTS.has(segment))) return true;
  const sampleIndex = segments.findIndex(segment => segment === 'examples' || segment === 'samples');
  if (sampleIndex < 0) return false;
  const languageRoot = segments.findIndex(segment =>
    ['java', 'kotlin', 'scala', 'groovy'].includes(segment));
  // In JVM layouts `samples` is often an ordinary reverse-DNS/package segment
  // (for example org/springframework/samples/petclinic), not a sample-project tree.
  return languageRoot < 0 || sampleIndex < languageRoot;
}

function normalizeDomainSegment(value: string): string {
  for (const [pattern, replacement] of DOMAIN_PATTERNS) {
    if (pattern.test(value)) return replacement || value.toLowerCase();
  }
  return value.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
}
