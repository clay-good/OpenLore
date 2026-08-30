import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import { hasMagic } from 'glob';
import { Minimatch } from 'minimatch';
import { parse as parseYaml } from 'yaml';
import { readSourceCapped } from './bounded-file-scan.js';

export interface WorkspaceShardConfig {
  name: string;
  root: string;
}

export interface WorkspaceShard {
  name: string;
  root: string;
  manifest: string | null;
  files: string[];
}

export interface IgnoredWorkspaceMember {
  manifest: string;
  member: string;
  reason: 'outside-root' | 'invalid';
}

export interface WorkspaceShardReport {
  source: 'configured' | 'detected' | 'single-root';
  shards: WorkspaceShard[];
  ignoredMembers: IgnoredWorkspaceMember[];
}

export const MAX_WORKSPACE_MEMBER_PATTERNS = 2_000;
export const MAX_WORKSPACE_SHARDS = 5_000;
export const MAX_SHARD_NAME_CHARS = 256;
export const MAX_SHARD_ROOT_CHARS = 1_024;
export const MAX_SHARD_MANIFEST_CHARS = 4_096;
const MAX_SELECTED_SHARDS = 1_000;
const MAX_WORKSPACE_DIRECTORY_CANDIDATES = 100_000;
const MAX_WORKSPACE_PATTERN_CHECKS = 2_000_000;
const MAX_UNKNOWN_SUGGESTIONS = 3;

interface Candidate {
  root: string;
  manifest: string;
  preferredName?: string;
}

function utf8Length(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function hasControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

function stripControlCharacters(value: string): string {
  let result = '';
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code > 0x1f && (code < 0x7f || code > 0x9f)) result += char;
  }
  return result;
}

function truncateUtf8(value: string, maxBytes: number): string {
  let result = '';
  let bytes = 0;
  for (const char of value) {
    const charBytes = utf8Length(char);
    if (bytes + charBytes > maxBytes) break;
    result += char;
    bytes += charBytes;
  }
  return result;
}

function posixPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, '');
}

function isWithinRoot(rootPath: string, candidate: string): boolean {
  const rel = relative(rootPath, candidate);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.split(/[\\/]/).includes('..'));
}

function isAbsoluteLike(path: string): boolean {
  return isAbsolute(path) || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith('\\\\');
}

async function safeRead(rootPath: string, rel: string): Promise<string | null> {
  const abs = resolve(rootPath, rel);
  if (!isWithinRoot(rootPath, abs)) return null;
  try {
    return await readSourceCapped(abs);
  } catch {
    return null;
  }
}

async function expandMembers(
  rootPath: string,
  manifest: string,
  members: string[],
  ignored: IgnoredWorkspaceMember[],
  availableDirectories: ReadonlySet<string>,
  discoveredRoots: Set<string>,
  budget: { patternChecks: number },
): Promise<string[]> {
  const base = dirname(manifest);
  const roots = new Set<string>();
  if (members.length > MAX_WORKSPACE_MEMBER_PATTERNS) {
    throw new Error(`${manifest} declares ${members.length} workspace patterns; maximum is ${MAX_WORKSPACE_MEMBER_PATTERNS}`);
  }
  const positive: string[] = [];
  const excluded: string[] = [];
  for (const raw of members) {
    const negated = raw.trim().startsWith('!');
    const member = posixPath(raw.trim().replace(/^!/, ''));
    if (!member) continue;
    if (utf8Length(member) > MAX_SHARD_ROOT_CHARS || hasControlCharacters(member) || /[{}]/.test(member)) {
      ignored.push({ manifest, member: raw, reason: 'invalid' });
      continue;
    }
    const lexical = resolve(rootPath, base, member);
    if (!isWithinRoot(rootPath, lexical)) {
      ignored.push({ manifest, member: raw, reason: 'outside-root' });
      continue;
    }
    (negated ? excluded : positive).push(member);
  }
  try {
    const canonicalRoot = await realpath(rootPath).catch(() => rootPath);
    const positiveExact = positive.filter(pattern => !hasMagic(pattern));
    const excludedExact = excluded.filter(pattern => !hasMagic(pattern));
    const positiveExactSet = new Set(positiveExact);
    const excludedExactSet = new Set(excludedExact);
    const positiveGlobs = positive.filter(pattern => !positiveExactSet.has(pattern))
      .map(pattern => new Minimatch(pattern, { dot: true, nobrace: true }));
    const excludedGlobs = excluded.filter(pattern => !excludedExactSet.has(pattern))
      .map(pattern => new Minimatch(pattern, { dot: true, nobrace: true }));
    const matchedDirectories = new Set<string>();
    for (const pattern of positiveExact) {
      const directory = posixPath(relative(rootPath, resolve(rootPath, base, pattern)));
      if (directory && availableDirectories.has(directory)) matchedDirectories.add(directory);
    }
    if (positiveGlobs.length > 0) {
      for (const directory of availableDirectories) {
        const relativeDirectory = relative(base === '.' ? '' : base, directory);
        const match = relativeDirectory === '' ? '.' : posixPath(relativeDirectory);
        if (match === '..' || match.startsWith('../')) continue;
        for (const pattern of positiveGlobs) {
          if (++budget.patternChecks > MAX_WORKSPACE_PATTERN_CHECKS) {
            throw new Error(`Workspace expansion exceeds ${MAX_WORKSPACE_PATTERN_CHECKS} pattern checks`);
          }
          if (pattern.match(match)) { matchedDirectories.add(directory); break; }
        }
      }
    }
    const excludedDirectories = new Set(excludedExact.map(pattern =>
      posixPath(relative(rootPath, resolve(rootPath, base, pattern)))));
    for (const directory of matchedDirectories) {
      const relativeDirectory = relative(base === '.' ? '' : base, directory);
      const match = relativeDirectory === '' ? '.' : posixPath(relativeDirectory);
      if (excludedDirectories.has(directory)) continue;
      let isExcluded = false;
      for (const pattern of excludedGlobs) {
        if (++budget.patternChecks > MAX_WORKSPACE_PATTERN_CHECKS) {
          throw new Error(`Workspace expansion exceeds ${MAX_WORKSPACE_PATTERN_CHECKS} pattern checks`);
        }
        if (pattern.match(match)) { isExcluded = true; break; }
      }
      if (isExcluded) continue;
      const abs = resolve(rootPath, directory);
      const canonicalMatch = await realpath(abs).catch(() => abs);
      if (!isWithinRoot(rootPath, abs) || !isWithinRoot(canonicalRoot, canonicalMatch)) {
        ignored.push({ manifest, member: match, reason: 'outside-root' });
        continue;
      }
      const rel = posixPath(relative(rootPath, abs));
      if (!rel || discoveredRoots.has(rel)) continue;
      if (discoveredRoots.size >= MAX_WORKSPACE_SHARDS) {
        throw new Error(`Workspace expansion exceeds ${MAX_WORKSPACE_SHARDS} matches`);
      }
      discoveredRoots.add(rel);
      roots.add(rel);
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Workspace expansion exceeds')) throw error;
    ignored.push({ manifest, member: positive.join(', '), reason: 'invalid' });
  }
  return [...roots].sort();
}

function tomlWorkspaceArray(source: string, key: string): string[] {
  const workspace = source.match(/\[workspace\]([\s\S]*?)(?=\n\s*\[|$)/)?.[1] ?? '';
  const literal = workspace.match(new RegExp(`\\b${key}\\s*=\\s*\\[([\\s\\S]*?)\\]`))?.[1] ?? '';
  return [...literal.matchAll(/["']([^"']+)["']/g)].map(match => match[1]);
}

function goWorkMembers(source: string): string[] {
  const block = source.match(/\buse\s*\(([\s\S]*?)\)/)?.[1];
  if (block !== undefined) {
    return block.split(/\r?\n/).map(line => line.replace(/\/\/.*$/, '').trim()).filter(Boolean);
  }
  return [...source.matchAll(/^\s*use\s+([^\s/][^\s]*)\s*$/gm)].map(match => match[1]);
}

function gradleMembers(source: string): string[] {
  const members: string[] = [];
  for (const match of source.matchAll(/\binclude\s*(?:\(|\s)([^\n)]*)/g)) {
    for (const quoted of match[1].matchAll(/["'](:?[^"']+)["']/g)) {
      members.push(quoted[1].replace(/^:/, '').replace(/:/g, '/'));
    }
  }
  return members;
}

function mavenMembers(source: string): string[] {
  return [...source.matchAll(/<module>\s*([^<]+?)\s*<\/module>/g)].map(match => match[1]);
}

async function packageName(rootPath: string, root: string): Promise<string | undefined> {
  const raw = await safeRead(rootPath, `${root}/package.json`);
  if (!raw) return undefined;
  try {
    const name = (JSON.parse(raw) as { name?: unknown }).name;
    const trimmed = typeof name === 'string' ? name.trim() : '';
    return trimmed && !hasControlCharacters(String(name)) && utf8Length(trimmed) <= MAX_SHARD_NAME_CHARS
      ? trimmed
      : undefined;
  } catch {
    return undefined;
  }
}

function boundedName(value: string, entropy: string): string {
  if (value && value !== 'root' && utf8Length(value) <= MAX_SHARD_NAME_CHARS) return value;
  const suffix = createHash('sha256').update(entropy).digest('hex').slice(0, 12);
  const prefix = truncateUtf8(value || 'shard', MAX_SHARD_NAME_CHARS - suffix.length - 1);
  return `${prefix}-${suffix}`;
}

function analyzedDirectories(files: readonly string[]): string[] {
  const directories = new Set<string>();
  for (const file of files) {
    let directory = posixPath(dirname(file));
    while (directory && directory !== '.') {
      directories.add(directory);
      if (directories.size > MAX_WORKSPACE_DIRECTORY_CANDIDATES) {
        throw new Error(`Workspace discovery exceeds ${MAX_WORKSPACE_DIRECTORY_CANDIDATES} analyzed directories`);
      }
      const parent = posixPath(dirname(directory));
      if (!parent || parent === '.' || parent === directory) break;
      directory = parent;
    }
  }
  return [...directories].sort();
}

function boundedIgnoredMembers(entries: IgnoredWorkspaceMember[]): IgnoredWorkspaceMember[] {
  return entries.slice(0, MAX_WORKSPACE_MEMBER_PATTERNS).map(entry => ({
    manifest: truncateUtf8(stripControlCharacters(entry.manifest), MAX_SHARD_MANIFEST_CHARS),
    member: truncateUtf8(stripControlCharacters(entry.member), MAX_SHARD_ROOT_CHARS),
    reason: entry.reason,
  }));
}

function uniqueNames(candidates: Candidate[]): Array<Candidate & { name: string }> {
  const preferred = candidates.map(candidate => boundedName(
    candidate.preferredName || basename(candidate.root) || 'shard',
    candidate.root,
  ));
  const counts = new Map<string, number>();
  counts.set('root', 1); // reserved for the implicit unmatched-files shard
  for (const name of preferred) counts.set(name, (counts.get(name) ?? 0) + 1);
  return candidates.map((candidate, index) => ({
    ...candidate,
    name: counts.get(preferred[index]) === 1
      ? preferred[index]
      : boundedName(candidate.root, `${candidate.root}\0${candidate.manifest}`),
  }));
}

/** Detect package boundaries, then partition the already-filtered analyzer corpus. */
export async function detectWorkspaceShards(
  rootPath: string,
  analyzedFiles: readonly string[],
  configured?: readonly WorkspaceShardConfig[],
): Promise<WorkspaceShardReport> {
  const files = [...new Set(analyzedFiles.map(posixPath))].sort();
  const ignoredMembers: IgnoredWorkspaceMember[] = [];
  const availableDirectories = new Set(analyzedDirectories(files));
  const discoveredRoots = new Set<string>();
  const expansionBudget = { patternChecks: 0 };
  const candidateRoots = new Set<string>();
  let candidates: Candidate[] = [];
  let source: WorkspaceShardReport['source'] = 'detected';
  const addCandidate = (candidate: Candidate): void => {
    if (!candidate.root || candidateRoots.has(candidate.root)) return;
    if (candidateRoots.size >= MAX_WORKSPACE_SHARDS) {
      throw new Error(`Detected more than ${MAX_WORKSPACE_SHARDS} workspace shards`);
    }
    candidateRoots.add(candidate.root);
    candidates.push(candidate);
  };

  if (configured) {
    source = 'configured';
    if (configured.length > MAX_WORKSPACE_SHARDS) {
      throw new Error(`workspace.shards declares ${configured.length} shards; maximum is ${MAX_WORKSPACE_SHARDS}`);
    }
    const configuredNames = new Set<string>();
    const configuredRoots = new Set<string>();
    const canonicalRoot = await realpath(rootPath).catch(() => rootPath);
    for (const shard of configured) {
      const name = shard.name.trim();
      if (hasControlCharacters(shard.name) || hasControlCharacters(shard.root)) {
        throw new Error(`workspace.shards has control characters in name or root: '${name}'`);
      }
      if (isAbsoluteLike(shard.root)) {
        throw new Error(`workspace.shards root must be repository-relative: '${shard.root}'`);
      }
      const abs = resolve(rootPath, shard.root);
      const root = posixPath(relative(rootPath, abs));
      if (!name || name === 'root' || hasControlCharacters(name)
        || utf8Length(name) > MAX_SHARD_NAME_CHARS || configuredNames.has(name)) {
        throw new Error(`workspace.shards has an invalid, reserved, or duplicate name: '${shard.name}'`);
      }
      if (!root || hasControlCharacters(root)
        || utf8Length(root) > MAX_SHARD_ROOT_CHARS || configuredRoots.has(root)) {
        throw new Error(`workspace.shards has an invalid or duplicate root: '${shard.root}'`);
      }
      if (!isWithinRoot(rootPath, abs)) {
        throw new Error(`workspace.shards root resolves outside the repository: '${shard.root}'`);
      }
      const canonicalAbs = await realpath(abs).catch(() => null);
      if (canonicalAbs && !isWithinRoot(canonicalRoot, canonicalAbs)) {
        throw new Error(`workspace.shards root resolves outside the repository: '${shard.root}'`);
      }
      configuredNames.add(name);
      configuredRoots.add(root);
      addCandidate({ root, manifest: 'workspace.shards', preferredName: name });
    }
  } else {
    const manifests = files.filter(file => /(^|\/)(?:package\.json|pnpm-workspace\.yaml|Cargo\.toml|go\.work|go\.mod|pyproject\.toml|settings\.gradle(?:\.kts)?|pom\.xml)$/.test(file));
    let declaredPatterns = 0;
    for (const manifest of manifests) {
      const raw = await safeRead(rootPath, manifest);
      if (raw === null) continue;
      let members: string[] = [];
      if (manifest.endsWith('package.json')) {
        try {
          const workspaces = (JSON.parse(raw) as { workspaces?: unknown }).workspaces;
          members = Array.isArray(workspaces)
            ? workspaces.filter((value): value is string => typeof value === 'string')
            : typeof workspaces === 'object' && workspaces !== null && Array.isArray((workspaces as { packages?: unknown }).packages)
              ? (workspaces as { packages: unknown[] }).packages.filter((value): value is string => typeof value === 'string')
              : [];
        } catch { /* malformed manifests are not workspace evidence */ }
      } else if (manifest.endsWith('pnpm-workspace.yaml')) {
        try {
          const parsed = parseYaml(raw) as { packages?: unknown } | null;
          members = Array.isArray(parsed?.packages) ? parsed.packages.filter((value): value is string => typeof value === 'string') : [];
        } catch { /* malformed manifests are not workspace evidence */ }
      } else if (manifest.endsWith('Cargo.toml')) {
        members = [
          ...tomlWorkspaceArray(raw, 'members'),
          ...tomlWorkspaceArray(raw, 'exclude').map(member => `!${member}`),
        ];
      }
      else if (manifest.endsWith('go.work')) members = goWorkMembers(raw);
      else if (/settings\.gradle(?:\.kts)?$/.test(manifest)) members = gradleMembers(raw);
      else if (manifest.endsWith('pom.xml')) members = mavenMembers(raw);

      declaredPatterns += members.length;
      if (declaredPatterns > MAX_WORKSPACE_MEMBER_PATTERNS) {
        throw new Error(`Workspace manifests declare more than ${MAX_WORKSPACE_MEMBER_PATTERNS} member patterns`);
      }
      for (const memberRoot of await expandMembers(
        rootPath,
        manifest,
        members,
        ignoredMembers,
        availableDirectories,
        discoveredRoots,
        expansionBudget,
      )) {
        addCandidate({ root: memberRoot, manifest, preferredName: await packageName(rootPath, memberRoot) });
      }
      if ((manifest.endsWith('go.mod') || manifest.endsWith('pyproject.toml')) && dirname(manifest) !== '.') {
        addCandidate({ root: posixPath(dirname(manifest)), manifest });
      }
    }
  }

  const byRoot = new Map<string, Candidate>();
  for (const candidate of candidates.sort((a, b) => a.root.localeCompare(b.root) || a.manifest.localeCompare(b.manifest))) {
    if (candidate.root && !byRoot.has(candidate.root)) byRoot.set(candidate.root, candidate);
  }
  candidates = [...byRoot.values()];
  candidates = candidates.filter(candidate => {
    if (!hasControlCharacters(candidate.root) && !hasControlCharacters(candidate.manifest)
      && utf8Length(candidate.root) <= MAX_SHARD_ROOT_CHARS
      && utf8Length(candidate.manifest) <= MAX_SHARD_MANIFEST_CHARS) return true;
    ignoredMembers.push({ manifest: candidate.manifest, member: candidate.root, reason: 'invalid' });
    return false;
  });
  if (candidates.length > MAX_WORKSPACE_SHARDS) {
    throw new Error(`Detected ${candidates.length} workspace shards; maximum is ${MAX_WORKSPACE_SHARDS}`);
  }
  if (candidates.length === 0) {
    return {
      source: configured ? 'configured' : 'single-root',
      ignoredMembers: boundedIgnoredMembers(ignoredMembers),
      shards: [{ name: 'root', root: '', manifest: null, files }],
    };
  }

  const named = uniqueNames(candidates);
  const ownerByRoot = new Map(named.map(candidate => [candidate.root, candidate]));
  const assignments = new Map(named.map(candidate => [candidate.root, [] as string[]]));
  const rootFiles: string[] = [];
  for (const file of files) {
    const segments = file.split('/');
    let owner: (typeof named)[number] | undefined;
    for (let length = segments.length; length > 0; length--) {
      owner = ownerByRoot.get(segments.slice(0, length).join('/'));
      if (owner) break;
    }
    if (owner) assignments.get(owner.root)!.push(file);
    else rootFiles.push(file);
  }
  const shards: WorkspaceShard[] = named.map(candidate => ({
    name: candidate.name,
    root: candidate.root,
    manifest: candidate.manifest,
    files: assignments.get(candidate.root)!,
  }));
  shards.push({ name: 'root', root: '', manifest: null, files: rootFiles });
  shards.sort((a, b) => a.name.localeCompare(b.name) || a.root.localeCompare(b.root));
  return { source, ignoredMembers: boundedIgnoredMembers(ignoredMembers), shards };
}

export function selectWorkspaceShards(report: WorkspaceShardReport, names: readonly string[]): WorkspaceShard[] {
  const wanted = new Set(names);
  return report.shards.filter(shard => wanted.has(shard.name));
}

function editDistance(left: string, right: string): number {
  let pattern = [...left];
  let text = [...right];
  if (pattern.length === 0) return text.length;
  if (text.length === 0) return pattern.length;
  if (pattern.length > text.length) [pattern, text] = [text, pattern];

  const equality = new Map<string, bigint>();
  for (let index = 0; index < pattern.length; index++) {
    equality.set(pattern[index], (equality.get(pattern[index]) ?? 0n) | (1n << BigInt(index)));
  }
  const highestBit = 1n << BigInt(pattern.length - 1);
  const mask = (1n << BigInt(pattern.length)) - 1n;
  let positive = mask;
  let negative = 0n;
  let score = pattern.length;
  for (const char of text) {
    const equal = equality.get(char) ?? 0n;
    const vertical = equal | negative;
    const horizontal = (((equal & positive) + positive) ^ positive) | equal;
    let positiveHorizontal = negative | ~(horizontal | positive);
    let negativeHorizontal = positive & horizontal;
    if ((positiveHorizontal & highestBit) !== 0n) score++;
    else if ((negativeHorizontal & highestBit) !== 0n) score--;
    positiveHorizontal = ((positiveHorizontal << 1n) | 1n) & mask;
    negativeHorizontal = (negativeHorizontal << 1n) & mask;
    positive = (negativeHorizontal | ~(vertical | positiveHorizontal)) & mask;
    negative = positiveHorizontal & vertical;
  }
  return score;
}

export function resolveWorkspaceShardSelection(report: WorkspaceShardReport, names: readonly string[]): WorkspaceShard[] {
  if (names.length > MAX_SELECTED_SHARDS) {
    throw new Error(`Too many workspace shards selected; maximum is ${MAX_SELECTED_SHARDS}`);
  }
  const available = report.shards.map(shard => shard.name);
  const invalid = names.find(name => utf8Length(name) > MAX_SHARD_NAME_CHARS);
  if (invalid) throw new Error(`Workspace shard name exceeds ${MAX_SHARD_NAME_CHARS} characters`);
  const unknown = [...new Set(names)].filter(name => !available.includes(name));
  if (unknown.length > 0) {
    const shownUnknown = unknown.slice(0, MAX_UNKNOWN_SUGGESTIONS);
    const nearest = shownUnknown.map(name => {
      const distance = new Map(available.map(candidate => [candidate, editDistance(name, candidate)]));
      const candidates = [...available]
        .sort((a, b) => distance.get(a)! - distance.get(b)! || a.localeCompare(b))
        .slice(0, 3);
      return `${name} (nearest: ${candidates.join(', ') || 'none'})`;
    });
    const unknownOmitted = unknown.length - shownUnknown.length;
    const shown = available.slice(0, 50);
    const omitted = available.length - shown.length;
    throw new Error(
      `Unknown workspace shard(s): ${nearest.join('; ')}`
      + (unknownOmitted > 0 ? `; … and ${unknownOmitted} more` : '')
      + `. Available shards: ${shown.join(', ')}`
      + (omitted > 0 ? ` … and ${omitted} more` : ''),
    );
  }
  const selected = selectWorkspaceShards(report, [...new Set(names)]);
  if (selected.length === 0) throw new Error(`No workspace shards selected. Available shards: ${available.join(', ')}`);
  return selected;
}
