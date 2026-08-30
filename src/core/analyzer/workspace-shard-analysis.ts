import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { open, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicWriteFile } from '../decisions/atomic-store.js';
import { withAnalysisLock } from '../runtime/advisory-lock.js';
import { EdgeStore } from '../services/edge-store.js';
import { computeAttestation, writeAttestation } from './index-attestation.js';
import { CallGraphBuilder } from './call-graph.js';
import { composeStaleFiles, spendClosureBudget } from './incremental-closure.js';
import { detectLanguage } from './signature-extractor.js';
import {
  MAX_SHARD_MANIFEST_CHARS,
  MAX_SHARD_NAME_CHARS,
  MAX_SHARD_ROOT_CHARS,
  MAX_WORKSPACE_MEMBER_PATTERNS,
  MAX_WORKSPACE_SHARDS,
  type WorkspaceShardReport,
} from './workspace-shards.js';
import { INCREMENTAL_CLOSURE_BUDGET, MAX_HTML_INLINE_SCRIPT_CHARS } from '../../constants.js';
import { extractHtmlScripts } from './html-script-extractor.js';
import { readSourceCapped } from './bounded-file-scan.js';
import { factKey } from './pass1-fact-cache.js';

export const ARTIFACT_WORKSPACE_SHARDS = 'workspace-shards.json';
const MAX_RECEIPT_SHARDS = MAX_WORKSPACE_SHARDS + 1; // detected/configured shards plus implicit root
const MAX_RECEIPT_FILE_ITEMS = 100_000;
const MAX_RECEIPT_PATH_CHARS = MAX_SHARD_MANIFEST_CHARS;
// Overall serialized bytes are part of the receipt schema. The writer checks
// this exact encoded bound before graph mutation; the reader applies the same
// bound before allocation, so every emitted receipt is readable.
export const MAX_SHARD_RECEIPT_BYTES = 64 * 1_048_576;

export interface ShardScopedAnalysisReceipt {
  version: 1;
  mode: 'full' | 'scoped';
  source: WorkspaceShardReport['source'];
  computedAt: string;
  recomputed: string[];
  retained: string[];
  frontierFiles: string[];
  staleFiles: string[];
  artifacts: { recomputed: string[]; retained: string[] };
  shards: Array<{
    name: string;
    root: string;
    manifest: string | null;
    fileCount: number;
    lastRecomputedAt: string | null;
    freshness: 'current' | 'stale' | 'unknown';
    fingerprint: string | null;
  }>;
  ignoredMembers: WorkspaceShardReport['ignoredMembers'];
}

function ownerOf(file: string, namesByRoot: ReadonlyMap<string, string>): string {
  const segments = file.split('/');
  for (let length = segments.length; length > 0; length--) {
    const owner = namesByRoot.get(segments.slice(0, length).join('/'));
    if (owner) return owner;
  }
  return 'root';
}

function boundedString(value: unknown, max: number): value is string {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > max) return false;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return false;
  }
  return true;
}

function jsonStringBytes(value: string): number {
  let bytes = 2; // quotes
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code === 0x22 || code === 0x5c) { bytes += 2; continue; }
    if (code <= 0x1f) { bytes += code === 0x08 || code === 0x09 || code === 0x0a
      || code === 0x0c || code === 0x0d ? 2 : 6; continue; }
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) { bytes += 4; index++; }
      else bytes += 6;
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) { bytes += 6; continue; }
    bytes += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : 3;
  }
  return bytes;
}

function prettyJsonBytes(value: unknown, depth = 0, limit = MAX_SHARD_RECEIPT_BYTES): number {
  if (value === null) return 4;
  if (typeof value === 'string') return jsonStringBytes(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value).length;
  if (Array.isArray(value)) {
    if (value.length === 0) return 2;
    let bytes = 2; // opening bracket + newline
    for (let index = 0; index < value.length; index++) {
      bytes += (depth + 1) * 2 + prettyJsonBytes(value[index], depth + 1, limit - bytes)
        + (index + 1 === value.length ? 1 : 2); // newline, plus comma except last
      if (bytes > limit) return bytes;
    }
    return bytes + depth * 2 + 1;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return 2;
    let bytes = 2;
    for (let index = 0; index < entries.length; index++) {
      const [key, child] = entries[index];
      bytes += (depth + 1) * 2 + jsonStringBytes(key) + 2
        + prettyJsonBytes(child, depth + 1, limit - bytes)
        + (index + 1 === entries.length ? 1 : 2);
      if (bytes > limit) return bytes;
    }
    return bytes + depth * 2 + 1;
  }
  return 4;
}

export function serializeShardReceipt(receipt: ShardScopedAnalysisReceipt): string {
  if (!isShardReceipt(receipt) || prettyJsonBytes(receipt) > MAX_SHARD_RECEIPT_BYTES) {
    throw new Error(`Workspace shard receipt exceeds its bounded schema`);
  }
  const serialized = JSON.stringify(receipt, null, 2);
  if (Buffer.byteLength(serialized, 'utf8') > MAX_SHARD_RECEIPT_BYTES) {
    throw new Error(`Workspace shard receipt exceeds its bounded schema`);
  }
  return serialized;
}

function boundedStringArray(
  value: unknown,
  maxItems = MAX_RECEIPT_FILE_ITEMS,
  maxChars = MAX_RECEIPT_PATH_CHARS,
): value is string[] {
  return Array.isArray(value)
    && value.length <= maxItems
    && value.every(item => boundedString(item, maxChars));
}

function isShardReceipt(value: unknown): value is ShardScopedAnalysisReceipt {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const receipt = value as Record<string, unknown>;
  if (receipt.version !== 1 || (receipt.mode !== 'full' && receipt.mode !== 'scoped')) return false;
  if (!['configured', 'detected', 'single-root'].includes(String(receipt.source))) return false;
  if (!boundedString(receipt.computedAt, 64)
    || !boundedStringArray(receipt.recomputed, MAX_RECEIPT_SHARDS, MAX_SHARD_NAME_CHARS)
    || !boundedStringArray(receipt.retained, MAX_RECEIPT_SHARDS, MAX_SHARD_NAME_CHARS)
    || !boundedStringArray(receipt.frontierFiles)
    || !boundedStringArray(receipt.staleFiles)) return false;
  if (typeof receipt.artifacts !== 'object' || receipt.artifacts === null || Array.isArray(receipt.artifacts)) return false;
  const artifacts = receipt.artifacts as Record<string, unknown>;
  if (!boundedStringArray(artifacts.recomputed, 64) || !boundedStringArray(artifacts.retained, 64)) return false;
  if (!Array.isArray(receipt.shards) || receipt.shards.length > MAX_RECEIPT_SHARDS) return false;
  for (const value of receipt.shards) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
    const shard = value as Record<string, unknown>;
    if (!boundedString(shard.name, MAX_SHARD_NAME_CHARS) || !boundedString(shard.root, MAX_SHARD_ROOT_CHARS)) return false;
    if (shard.manifest !== null && !boundedString(shard.manifest, MAX_SHARD_MANIFEST_CHARS)) return false;
    if (!Number.isSafeInteger(shard.fileCount) || Number(shard.fileCount) < 0) return false;
    if (shard.lastRecomputedAt !== null && !boundedString(shard.lastRecomputedAt, 64)) return false;
    if (!['current', 'stale', 'unknown'].includes(String(shard.freshness))) return false;
    if (shard.fingerprint !== null && (!boundedString(shard.fingerprint, 64) || !/^[a-f0-9]{64}$/.test(shard.fingerprint))) return false;
  }
  if (!Array.isArray(receipt.ignoredMembers) || receipt.ignoredMembers.length > MAX_WORKSPACE_MEMBER_PATTERNS) return false;
  return receipt.ignoredMembers.every(value => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
    const ignored = value as Record<string, unknown>;
    return boundedString(ignored.manifest, MAX_SHARD_MANIFEST_CHARS)
      && boundedString(ignored.member, MAX_SHARD_ROOT_CHARS)
      && (ignored.reason === 'outside-root' || ignored.reason === 'invalid');
  });
}

export async function readPriorShardReceipt(outputPath: string): Promise<ShardScopedAnalysisReceipt | null> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(
      join(outputPath, ARTIFACT_WORKSPACE_SHARDS),
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
    );
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_SHARD_RECEIPT_BYTES) return null;
    const buffer = Buffer.alloc(Math.min(info.size + 1, MAX_SHARD_RECEIPT_BYTES + 1));
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > MAX_SHARD_RECEIPT_BYTES) return null;
    const parsed: unknown = JSON.parse(buffer.subarray(0, offset).toString('utf8'));
    return isShardReceipt(parsed) ? parsed : null;
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

function shardFingerprintFromHashes(
  files: readonly string[],
  hashes: ReadonlyMap<string, string>,
): string | null {
  const hash = createHash('sha256');
  for (const file of [...files].sort()) {
    const contentHash = hashes.get(file);
    if (contentHash === undefined) return null;
    hash.update(file).update('\0').update(contentHash).update('\0');
  }
  return hash.digest('hex');
}

async function shardFingerprint(rootPath: string, files: readonly string[]): Promise<string | null> {
  const hashes = new Map<string, string>();
  try {
    for (const file of [...files].sort()) {
      const content = await readSourceCapped(join(rootPath, file));
      if (content === null) return null;
      hashes.set(file, createHash('sha256').update(content).digest('hex'));
    }
  } catch {
    return null;
  }
  return shardFingerprintFromHashes(files, hashes);
}

export async function writeFullShardReceipt(
  outputPath: string,
  report: WorkspaceShardReport,
  rootPath: string,
): Promise<ShardScopedAnalysisReceipt | null> {
  // Preserve the legacy single-package artifact set byte-for-byte.
  if (report.source === 'single-root') {
    await unlink(join(outputPath, ARTIFACT_WORKSPACE_SHARDS)).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    });
    return null;
  }
  const computedAt = new Date().toISOString();
  const shards: ShardScopedAnalysisReceipt['shards'] = [];
  for (const shard of report.shards) {
    shards.push({
      name: shard.name,
      root: shard.root,
      manifest: shard.manifest,
      fileCount: shard.files.length,
      lastRecomputedAt: computedAt,
      freshness: 'current',
      fingerprint: await shardFingerprint(rootPath, shard.files),
    });
  }
  const receipt: ShardScopedAnalysisReceipt = {
    version: 1,
    mode: 'full',
    source: report.source,
    computedAt,
    recomputed: report.shards.map(shard => shard.name),
    retained: [],
    frontierFiles: [],
    staleFiles: [],
    artifacts: { recomputed: ['repository-wide artifact set'], retained: [] },
    shards,
    ignoredMembers: report.ignoredMembers,
  };
  const receiptJson = serializeShardReceipt(receipt);
  await atomicWriteFile(join(outputPath, ARTIFACT_WORKSPACE_SHARDS), receiptJson);
  return receipt;
}

async function graphInput(rootPath: string, files: readonly string[]): Promise<{
  input: Array<{ path: string; content: string; language: string }>;
  skipped: string[];
  hashes: Map<string, string>;
  factKeys: Map<string, string>;
}> {
  const input: Array<{ path: string; content: string; language: string }> = [];
  const skipped: string[] = [];
  const hashes = new Map<string, string>();
  const factKeys = new Map<string, string>();
  for (const path of [...new Set(files)].sort()) {
    try {
      const original = await readSourceCapped(join(rootPath, path));
      if (original === null) {
        skipped.push(path);
        continue;
      }
      hashes.set(path, createHash('sha256').update(original).digest('hex'));
      let content = original;
      let language = detectLanguage(path);
      if (language === 'unknown' && /\.html?$/i.test(path)) {
        const blanked = original.length <= MAX_HTML_INLINE_SCRIPT_CHARS ? extractHtmlScripts(original) : null;
        if (blanked) { content = blanked; language = 'JavaScript'; }
      }
      input.push({ path, content, language });
      factKeys.set(path, factKey({ path, content, language }));
    } catch {
      skipped.push(path);
    }
  }
  return { input, skipped, hashes, factKeys };
}

/**
 * Replace selected shard rows while retaining the rest of the production graph.
 * Repo-wide JSON artifacts are intentionally untouched; the receipt names that this
 * was a scoped graph update, and a later full analyze re-aggregates those artifacts.
 */
export async function runShardScopedAnalysis(args: {
  rootPath: string;
  outputPath: string;
  report: WorkspaceShardReport;
  selectedNames: readonly string[];
  closureBudget?: number;
}): Promise<ShardScopedAnalysisReceipt> {
  const { rootPath, outputPath, report } = args;
  const selectedNameSet = new Set(args.selectedNames);
  const selectedShards = report.shards.filter(shard => selectedNameSet.has(shard.name));
  const namesByRoot = new Map(report.shards.filter(shard => shard.root).map(shard => [shard.root, shard.name]));
  const currentSelectedFiles = new Set(selectedShards.flatMap(shard => shard.files));
  const computedAt = new Date().toISOString();

  return withAnalysisLock(outputPath, async () => {
    // Parse and fully validate the untrusted prior receipt before any graph or
    // attestation mutation so malformed state cannot cause a post-commit failure.
    const prior = await readPriorShardReceipt(outputPath);
    const store = EdgeStore.open(EdgeStore.dbPath(outputPath));
    try {
      if (store.notReady) throw new Error(store.notReady.message);
      const oldNodes = store.getAllInternalNodes();
      const oldClasses = store.getAllClasses();
      const pass1HashByFile = new Map(
        (store.hasPass1Facts() ? store.listPass1FactKeys() : []).map(row => [row.filePath, row.contentHash]),
      );
      const oldSelectedFiles = new Set(
        oldNodes.map(node => node.filePath).filter(file => selectedNameSet.has(ownerOf(file, namesByRoot))),
      );
      const selectedFiles = [...new Set([...currentSelectedFiles, ...oldSelectedFiles])].sort();
      const selectedFileSet = new Set(selectedFiles);
      const selectedOldNodes = oldNodes.filter(node => selectedFileSet.has(node.filePath));
      const selectedOldIds = new Set(selectedOldNodes.map(node => node.id));
      const selectedOldClasses = oldClasses.filter(cls => selectedFileSet.has(cls.filePath));
      const oldNameCounts = new Map<string, number>();
      for (const node of selectedOldNodes) oldNameCounts.set(node.name, (oldNameCounts.get(node.name) ?? 0) + 1);

      // Class 1: every outside endpoint touching a selected file in the persisted graph.
      const frontier = new Set<string>();
      const fileByNodeId = new Map(oldNodes.map(node => [node.id, node.filePath]));
      for (const edge of store.getAllEdges()) {
        const callerFile = fileByNodeId.get(edge.callerId);
        const calleeFile = fileByNodeId.get(edge.calleeId);
        const callerSelected = callerFile !== undefined && selectedFileSet.has(callerFile);
        const calleeSelected = calleeFile !== undefined && selectedFileSet.has(calleeFile);
        if (callerSelected && calleeFile && calleeFile !== 'external' && !calleeSelected) frontier.add(calleeFile);
        if (calleeSelected && callerFile && callerFile !== 'external' && !callerSelected) frontier.add(callerFile);
      }

      const seedNodes = oldNodes.filter(node => !selectedOldIds.has(node.id));
      const first = await graphInput(rootPath, [...currentSelectedFiles]);
      if (first.skipped.length > 0) {
        throw new Error(`selected shard files became unreadable during analysis: ${first.skipped.join(', ')}`);
      }
      const firstGraph = await new CallGraphBuilder().build(first.input, undefined, undefined, seedNodes);
      const newNameCounts = new Map<string, number>();
      for (const node of firstGraph.nodes.values()) {
        if (!node.isExternal) newNameCounts.set(node.name, (newNameCounts.get(node.name) ?? 0) + 1);
      }
      const changedNames = new Set([...oldNameCounts.keys(), ...newNameCounts.keys()].filter(
        name => oldNameCounts.get(name) !== newNameCounts.get(name),
      ));

      // Classes 2 and 3, conservatively for both additions and removals. External
      // rows preserve unresolved ambiguous sites, so removals that restore uniqueness
      // are covered alongside additions that newly bind a name.
      for (const name of changedNames) {
        for (const file of store.getExternalConsumerFiles(name)) {
          if (!selectedFileSet.has(file) && file !== 'external') frontier.add(file);
        }
        for (const { file } of store.getNameOnlyConsumers(name)) {
          if (!selectedFileSet.has(file) && file !== 'external') frontier.add(file);
        }
        // The resolver intentionally persists no edge for some ambiguous bare calls.
        // When a definition is REMOVED, one of those invisible sites may become unique;
        // there is no sound SQLite query that can locate it. Conservatively include every
        // outside graphable file in the bounded frontier. The budget then either converges
        // it or marks it stale, preserving the never-silent contract.
        if ((newNameCounts.get(name) ?? 0) < (oldNameCounts.get(name) ?? 0)) {
          for (const file of report.shards.flatMap(shard => shard.files)) {
            if (!selectedFileSet.has(file) && (detectLanguage(file) !== 'unknown' || /\.html?$/i.test(file))) {
              frontier.add(file);
            }
          }
        }
      }

      const oldClassNameCounts = new Map<string, number>();
      for (const cls of selectedOldClasses) {
        oldClassNameCounts.set(cls.name, (oldClassNameCounts.get(cls.name) ?? 0) + 1);
      }
      const newClassNameCounts = new Map<string, number>();
      for (const cls of firstGraph.classes) {
        newClassNameCounts.set(cls.name, (newClassNameCounts.get(cls.name) ?? 0) + 1);
      }
      const classNamesChanged = [...oldClassNameCounts.keys(), ...newClassNameCounts.keys()]
        .some(name => oldClassNameCounts.get(name) !== newClassNameCounts.get(name));
      if (classNamesChanged) {
        for (const cls of oldClasses) {
          if (!selectedFileSet.has(cls.filePath)) frontier.add(cls.filePath);
        }
      }

      const budgeted = spendClosureBudget(
        [...frontier],
        args.closureBudget ?? INCREMENTAL_CLOSURE_BUDGET,
        oldNodes,
      );
      const finalFiles = [...currentSelectedFiles, ...budgeted.selected];
      const prepared = await graphInput(rootPath, finalFiles);
      const unreadableFrontier = prepared.skipped.filter(file => !currentSelectedFiles.has(file));
      if (prepared.skipped.some(file => currentSelectedFiles.has(file))) {
        throw new Error(`selected shard files became unreadable during analysis: ${prepared.skipped.join(', ')}`);
      }
      // A retained frontier file may itself have changed since the full index. Updating
      // its nodes would require recursively deriving another shard's name frontier; using
      // its new edges with old nodes would be worse. Preserve it, mark it stale, and let a
      // later selection/full run converge it explicitly.
      const changedRetainedFrontier = budgeted.selected.filter(file => {
        const currentRaw = prepared.hashes.get(file);
        const persistedRaw = store.getFileHash(file);
        if (persistedRaw !== null) return currentRaw !== undefined && persistedRaw !== currentRaw;
        const currentFactKey = prepared.factKeys.get(file);
        const persistedFactKey = pass1HashByFile.get(file);
        return currentFactKey !== undefined && (persistedFactKey === undefined || persistedFactKey !== currentFactKey);
      });
      const changedRetainedSet = new Set(changedRetainedFrontier);
      const buildInput = prepared.input.filter(file => !changedRetainedSet.has(file.path));
      const recomputedFiles = new Set(buildInput.map(file => file.path));
      const resolutionNodes = oldNodes.filter(node => !recomputedFiles.has(node.filePath));
      const resolutionClasses = oldClasses.filter(cls => !recomputedFiles.has(cls.filePath));
      const result = await new CallGraphBuilder().build(
        buildInput,
        undefined,
        undefined,
        resolutionNodes,
        resolutionClasses,
      );
      const resultNodes = [...result.nodes.values()];
      const testNodeIds = new Set(resultNodes.filter(node => node.isTest).map(node => node.id));
      const productionNodes = resultNodes.filter(node => !node.isTest);
      const productionEdges = result.edges.filter(edge =>
        edge.kind !== 'tested_by' && !testNodeIds.has(edge.callerId) && !testNodeIds.has(edge.calleeId));
      const selectedResultNodes = productionNodes.filter(node => currentSelectedFiles.has(node.filePath) || node.isExternal);
      const selectedClasses = result.classes.filter(cls => currentSelectedFiles.has(cls.filePath));
      const allResultClassIds = new Set(result.classes.map(cls => cls.id));
      const recomputedClassIds = new Set(
        result.classes.filter(cls => recomputedFiles.has(cls.filePath)).map(cls => cls.id),
      );
      const inheritanceEdges = [
        ...store.getAllInheritanceEdges().filter(edge =>
          edge.kind !== 'overrides'
          && !recomputedClassIds.has(edge.childId)
          && allResultClassIds.has(edge.parentId)
          && allResultClassIds.has(edge.childId)),
        ...result.inheritanceEdges.filter(edge =>
          edge.kind === 'overrides' || recomputedClassIds.has(edge.childId)),
      ];
      const staleFiles = [...new Set([...budgeted.dropped, ...unreadableFrontier, ...changedRetainedFrontier])].sort();
      const priorShards = new Map(prior?.shards.map(shard => [shard.name, shard]) ?? []);
      const shardStates: ShardScopedAnalysisReceipt['shards'] = [];
      for (const shard of report.shards) {
        const previous = priorShards.get(shard.name);
        const selected = selectedNameSet.has(shard.name);
        const fingerprint = selected
          ? shardFingerprintFromHashes(shard.files, prepared.hashes)
          : previous?.fingerprint ?? null;
        shardStates.push({
          name: shard.name,
          root: shard.root,
          manifest: shard.manifest,
          fileCount: shard.files.length,
          lastRecomputedAt: selected ? computedAt : previous?.lastRecomputedAt ?? null,
          freshness: selected ? 'current' : 'unknown',
          fingerprint,
        });
      }
      const receipt: ShardScopedAnalysisReceipt = {
        version: 1,
        mode: 'scoped',
        source: report.source,
        computedAt,
        recomputed: selectedShards.map(shard => shard.name),
        retained: report.shards.filter(shard => !selectedNameSet.has(shard.name)).map(shard => shard.name),
        frontierFiles: [...new Set([...budgeted.selected, ...budgeted.dropped])].sort(),
        staleFiles,
        artifacts: {
          recomputed: ['call-graph.db', 'index-attestation.json', 'workspace-shards.json'],
          retained: [
            'repo-structure.json', 'llm-context.json', 'dependency-graph.json', 'SUMMARY.md',
            'CODEBASE.md', 'dependencies.mermaid', 'parse-health.json', 'style-fingerprint.json',
            'vector index', 'BM25 corpus', 'repository vocabulary', 'text-line index',
          ],
        },
        shards: shardStates,
        ignoredMembers: report.ignoredMembers,
      };
      const receiptJson = serializeShardReceipt(receipt);

      store.transaction(() => {
        for (const file of selectedFiles) {
          store.deleteEdgesForFile(file);
          store.deleteNodesForFile(file);
          store.deleteClassesForFile(file);
          store.deleteCfgForFile(file);
          if (!currentSelectedFiles.has(file)) {
            store.deleteFileHash(file);
            store.deletePass1FactsForFile(file);
          }
        }
        for (const file of budgeted.selected.filter(file => !prepared.skipped.includes(file) && !changedRetainedSet.has(file))) {
          store.deleteOutgoingEdgesForFile(file);
        }
        store.insertNodes(selectedResultNodes);
        store.insertEdges(productionEdges);
        store.deleteOrphanExternalNodes();
        store.insertClasses(selectedClasses);
        store.replaceInheritanceEdges(inheritanceEdges);
        store.recomputeStructuralMetrics();
        if (result.cfgs) {
          store.insertCfgs([...result.cfgs.entries()]
            .filter(([id]) => selectedOldIds.has(id) || currentSelectedFiles.has(result.nodes.get(id)?.filePath ?? ''))
            .map(([functionId, cfg]) => ({ functionId, filePath: result.nodes.get(functionId)!.filePath, cfg })));
        }
        for (const [file, hash] of prepared.hashes) {
          if (recomputedFiles.has(file)) store.setFileHash(file, hash);
        }
        store.clearFilesStale([...recomputedFiles]);
        if (staleFiles.length > 0) store.markFilesStale(staleFiles, Date.now(), composeStaleFiles(staleFiles, oldNodes));
      });
      // Unlike the latency-sensitive watcher, a requested scoped analyze can afford
      // an O(graph) digest pass. Re-attest the retained whole graph instead of carrying
      // a full-build digest that no longer describes the store.
      await writeAttestation(outputPath, computeAttestation(
        store.getSchemaVersion(),
        store.getAllInternalNodes(),
        store.getAllEdges(),
        store.getAllClasses(),
      ));

      await atomicWriteFile(join(outputPath, ARTIFACT_WORKSPACE_SHARDS), receiptJson);
      return receipt;
    } finally {
      store.close();
    }
  });
}
