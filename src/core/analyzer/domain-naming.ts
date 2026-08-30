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
  | 'fixture-tree'
  | 'documentation-file';

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

/**
 * Prose files: documentation, licences, and project meta. Never behavior.
 *
 * Extension-less project files are matched by their conventional stem, which is
 * how `LICENSE`, `NOTICE`, and `COPYING` are recognised — they carry no
 * extension and would otherwise fall through to production source.
 */
// `.mdx` is prose HERE because the analyzer does not parse it: no extractor, no
// language mapping, so an `.mdx` file yields no signature, route, or call edge
// and can carry no requirement anchor. In a Next.js or Docusaurus project those
// files are executable, and the day an extractor reads them this classification
// must move with it — otherwise real routes would be classified as prose.
const DOCUMENTATION_EXTENSIONS = new Set(['.md', '.mdx', '.mdc', '.markdown', '.rst', '.adoc', '.txt', '.cff']);

/**
 * `.txt` carries prose (`README.txt`, `LICENSE.txt`) and build configuration
 * (`requirements.txt`, `CMakeLists.txt`) under one extension, so the config
 * names are named explicitly rather than the whole extension being dropped.
 * Anything matched here falls through to the ordinary config/source rules.
 */
const BUILD_CONFIG_TEXT = /^(cmakelists|(requirements|constraints)(-[a-z0-9._-]+)?)\.txt$/;

function isBuildConfigText(name: string): boolean {
  // Anchored on the whole basename: an unanchored substring would capture
  // `product-requirements.txt`, which is prose. Under-matching is the safe
  // direction — a missed config file becomes supporting, which still cannot
  // define a domain, whereas a misread prose file would become defining.
  return BUILD_CONFIG_TEXT.test(name);
}
const DOCUMENTATION_STEMS = new Set([
  'authors',
  'changelog',
  'citation',
  'code_of_conduct',
  'codeowners',
  'contributors',
  'contributing',
  'copying',
  'governance',
  'licence',
  'license',
  'maintainers',
  'notice',
  'patents',
  'readme',
  'security',
  'support',
  'third_party_notices',
]);

export function isDocumentationFile(path: string): boolean {
  return classifyProseFile(path) === 'documentation';
}

/** Prose, a build-config file sharing a prose extension, or neither. */
function classifyProseFile(path: string): 'documentation' | 'build-config' | 'neither' {
  const rawName = path.replace(/\\/g, '/').split('/').pop() ?? '';
  const name = rawName.toLowerCase();
  const dot = name.lastIndexOf('.');
  const extension = dot > 0 ? name.slice(dot) : '';
  if (extension === '.txt' && isBuildConfigText(name)) return 'build-config';
  if (extension.length > 0 && DOCUMENTATION_EXTENSIONS.has(extension)) return 'documentation';

  // Conventional project files carry a qualifier rather than a file type:
  // `LICENSE-MIT`, `LICENSE_APACHE`, `COPYING.LESSER`. Match a complete known
  // name plus an optional qualifier, and require the conventional UPPER-CASE
  // spelling that marks project metadata. Without that, an extensionless
  // executable (`bin/readme`, `scripts/changelog`, `src/license`) and a source
  // file (`license.ts`, `readme-generator.ts`) would read as prose, and a domain
  // made of such scripts would be discarded. Matching a complete known name also
  // keeps compound conventions such as `CODE_OF_CONDUCT` precise without treating
  // a generic executable named `CODE` as supporting prose. Under-matching is the safe
  // direction: a lower-case `license` at the root is merely missed, never misread.
  if (rawName !== rawName.toUpperCase()) return 'neither';
  for (const stem of DOCUMENTATION_STEMS) {
    if (name === stem || name.startsWith(`${stem}.`) || name.startsWith(`${stem}-`) || name.startsWith(`${stem}_`)) {
      return 'documentation';
    }
  }
  return 'neither';
}

/**
 * Classify whether an analyzed file may define, only support, or never affect a domain.
 *
 * Documentation is `supporting`, never `defining`: prose describes a system, it
 * does not implement one, so a requirement can never be anchored to it. Because
 * a candidate whose files are all non-defining is already dropped as
 * `non-defining-only`, this alone stops a documentation-only tree from being
 * promoted to a domain the spec workflows would then offer as a target. It stays
 * `supporting` rather than `excluded` so a code domain keeps its docs as
 * footprint evidence (change: stop-specifying-documentation-as-behavior).
 */
export function classifyDomainFile(file: ScoredFile): DomainFileClassification {
  const segments = file.path.replace(/\\/g, '/').split('/').map(segment => segment.toLowerCase());
  if (file.tooling) return { role: 'excluded', reason: 'tooling-file' };
  if (file.isGenerated) return { role: 'excluded', reason: 'generated-file' };
  if (isFixtureOrSampleTree(segments)) {
    return { role: 'excluded', reason: 'fixture-tree' };
  }
  if (file.isTest) return { role: 'supporting', reason: 'test-file' };
  // Before the config check: the walker marks `config.md` / `settings.md` as
  // config by name, and prose about configuration is still prose.
  const prose = classifyProseFile(file.path);
  if (prose === 'documentation') return { role: 'supporting', reason: 'documentation-file' };
  // `requirements.txt` / `CMakeLists.txt` are build configuration, but the file
  // walker's CONFIG_PATTERNS does not name them, so `isConfig` is false and they
  // would fall through to production source and be able to define a domain.
  // Exclude them here rather than depending on a flag that is never set.
  if (prose === 'build-config' || file.isConfig) return { role: 'excluded', reason: 'config-file' };
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
