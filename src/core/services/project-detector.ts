/**
 * Project type detection service
 *
 * Detects the project type by checking for language-specific manifest files.
 */

import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { ProjectType } from '../../types/index.js';
import { fileExists } from '../../utils/command-helpers.js';

/** Depth-1 subdirs commonly holding a nested manifest (monorepo / polyglot layout). */
const NESTED_SCAN_IGNORE = new Set([
  'node_modules', '.git', 'dist', 'build', 'coverage', '.openlore', 'vendor', '.venv', 'target',
]);

/**
 * Project detection result
 */
export interface ProjectDetectionResult {
  projectType: ProjectType;
  manifestFile: string | null;
  hasGit: boolean;
  confidence: 'high' | 'medium' | 'low';
}

/**
 * Manifest file to project type mapping
 */
const MANIFEST_MAP: { file: string; type: ProjectType; priority: number }[] = [
  { file: 'package.json', type: 'nodejs', priority: 1 },
  { file: 'pyproject.toml', type: 'python', priority: 1 },
  { file: 'setup.py', type: 'python', priority: 2 },
  { file: 'requirements.txt', type: 'python', priority: 3 },
  { file: 'Cargo.toml', type: 'rust', priority: 1 },
  { file: 'go.mod', type: 'go', priority: 1 },
  { file: 'pom.xml', type: 'java', priority: 1 },
  { file: 'build.gradle', type: 'java', priority: 2 },
  { file: 'build.gradle.kts', type: 'java', priority: 2 },
  { file: 'Gemfile', type: 'ruby', priority: 1 },
  { file: 'composer.json', type: 'php', priority: 1 },
  // A pure-TS/JS project (no package.json — e.g. a Deno or config-only repo) is
  // still Node.js/TypeScript, not "Unknown". Lowest priority so a real language
  // manifest above always wins when both are present.
  { file: 'tsconfig.json', type: 'nodejs', priority: 9 },
  { file: 'jsconfig.json', type: 'nodejs', priority: 9 },
];

/**
 * Detect if the directory is a git repository
 */
export async function detectGitRepository(rootPath: string): Promise<boolean> {
  return fileExists(join(rootPath, '.git'));
}

/**
 * Detect the project type based on manifest files
 */
export async function detectProjectType(rootPath: string): Promise<ProjectDetectionResult> {
  const hasGit = await detectGitRepository(rootPath);

  // Check each manifest file
  const detectedManifests: { file: string; type: ProjectType; priority: number }[] = [];

  for (const manifest of MANIFEST_MAP) {
    if (await fileExists(join(rootPath, manifest.file))) {
      detectedManifests.push(manifest);
    }
  }

  // No manifest at the root — scan depth-1 subdirs before giving up, so a
  // nested layout (e.g. python/pyproject.toml, backend/go.mod) is not reported
  // as "Unknown" (Spec 26 B6A). Prefer the shallowest, highest-priority match.
  if (detectedManifests.length === 0) {
    const nested = await detectNestedManifest(rootPath);
    if (nested) {
      return {
        projectType: nested.type,
        manifestFile: nested.file,
        hasGit,
        confidence: 'medium',
      };
    }
    return {
      projectType: 'unknown',
      manifestFile: null,
      hasGit,
      confidence: 'low',
    };
  }

  // Sort by priority (lower is better) and pick the first
  detectedManifests.sort((a, b) => a.priority - b.priority);
  const primary = detectedManifests[0];

  // Determine confidence based on detection
  let confidence: 'high' | 'medium' | 'low' = 'high';
  if (detectedManifests.length > 1) {
    // Multiple project types detected
    const uniqueTypes = new Set(detectedManifests.map((m) => m.type));
    if (uniqueTypes.size > 1) {
      confidence = 'medium';
    }
  }

  return {
    projectType: primary.type,
    manifestFile: primary.file,
    hasGit,
    confidence,
  };
}

/**
 * Scan depth-1 subdirectories for a manifest when the root has none. Returns the
 * highest-priority manifest found in the shallowest matching subdir, or null.
 */
async function detectNestedManifest(
  rootPath: string
): Promise<{ file: string; type: ProjectType } | null> {
  let entries: string[];
  try {
    const dirents = await readdir(rootPath, { withFileTypes: true });
    entries = dirents
      .filter((d) => d.isDirectory() && !d.name.startsWith('.') && !NESTED_SCAN_IGNORE.has(d.name))
      .map((d) => d.name);
  } catch {
    return null;
  }

  const hits: { file: string; type: ProjectType; priority: number }[] = [];
  for (const sub of entries) {
    for (const manifest of MANIFEST_MAP) {
      if (await fileExists(join(rootPath, sub, manifest.file))) {
        hits.push({ file: join(sub, manifest.file), type: manifest.type, priority: manifest.priority });
      }
    }
  }
  if (hits.length === 0) return null;
  hits.sort((a, b) => a.priority - b.priority);
  return { file: hits[0].file, type: hits[0].type };
}

/**
 * Get a human-readable project type name
 */
export function getProjectTypeName(type: ProjectType): string {
  const names: Record<ProjectType, string> = {
    nodejs: 'Node.js/TypeScript',
    python: 'Python',
    rust: 'Rust',
    go: 'Go',
    java: 'Java',
    ruby: 'Ruby',
    php: 'PHP',
    unknown: 'Unknown',
  };
  return names[type];
}

/**
 * Read and parse package.json if it exists
 */
export async function readPackageJson(
  rootPath: string
): Promise<Record<string, unknown> | null> {
  const packagePath = join(rootPath, 'package.json');
  try {
    const content = await readFile(packagePath, 'utf-8');
    return JSON.parse(content);
  } catch {
    return null;
  }
}
