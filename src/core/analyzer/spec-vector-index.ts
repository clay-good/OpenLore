/**
 * SpecVectorIndex
 *
 * Builds and queries a LanceDB vector index over OpenSpec spec files.
 * Each record represents a logical section (requirement, purpose, design note...)
 * parsed from the Markdown spec files.
 *
 * Storage: <outputDir>/vector-index/  (same LanceDB folder as VectorIndex, different table)
 * Table name: "specs"
 *
 * Usage:
 *   // Build (or rebuild)
 *   await SpecVectorIndex.build(outputDir, specsDir, mappingJson, embedSvc);
 *
 *   // Search
 *   const results = await SpecVectorIndex.search(outputDir, "email validation", embedSvc);
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join, basename, dirname, relative, isAbsolute } from 'node:path';
import { fileExists } from '../../utils/command-helpers.js';
import { isConfinedPath, readFileConfined } from '../../utils/path-confinement.js';
import type { Embedder } from './embedding-service.js';
import { tokenize, buildBm25Corpus, bm25MatchEvidence, bm25Score } from './vector-index.js';
import type { MatchEvidence, SearchableFields } from './retrieval-evidence.js';
import { vectorMatchEvidence } from './retrieval-evidence.js';
import { atomicWriteFile } from '../decisions/atomic-store.js';
import { acquireLockAt, isLockHeld } from '../runtime/advisory-lock.js';

// ============================================================================
// TYPES
// ============================================================================

export interface SpecRecord {
  id: string;           // "analyzer.map"
  domain: string;       // "analyzer"
  section: string;      // "requirements" | "purpose" | "entities" | "design" | "architecture" | "other"
  title: string;        // "Requirement: Map" or "Purpose"
  /** Concatenated text used for embedding */
  text: string;
  /** Source files linked to this requirement (from mapping.json) */
  linkedFiles: string;  // JSON-encoded string[] (LanceDB stores as string)
  /** Embedding vector */
  vector: number[];
}

export interface SpecSearchResult {
  record: {
    id: string;
    domain: string;
    section: string;
    title: string;
    text: string;
    /** Parsed from JSON -- list of source file paths linked to this spec section */
    linkedFiles: string[];
  };
  score: number;
  /** Optional for legacy test doubles; every production search path emits it. */
  scoreKind?: 'bm25' | 'cosine_distance';
  /** Optional for legacy test doubles; every production search path emits it. */
  matchEvidence?: MatchEvidence;
}

// ============================================================================
// CONSTANTS
// ============================================================================

const DB_FOLDER = 'vector-index';
const TABLE_NAME = 'specs';

/**
 * Spec-index metadata sidecar, sibling to the LanceDB folder. Separate from the
 * function index's `vector-index-meta.json` so the two tables can have
 * independent embedding states. Source of truth for whether the spec table
 * supports ANN search.
 */
const META_FILE = 'spec-index-meta.json';
const FRESHNESS_FILE = 'spec-index-freshness.json';
const SPEC_INDEX_LOCK_FILE = '.spec-index.lock';
const META_SCHEMA_VERSION = 2;
const SPEC_ARTIFACT_MAX_BYTES = 4 * 1024 * 1024;
const FRESHNESS_MAX_BYTES = 256 * 1024;
const FRESHNESS_RETURNED_FILES = 1_000;
const FRESHNESS_MAX_PATH_BYTES = 1_024;

interface SpecIndexMeta {
  hasEmbeddings: boolean;
  dim: number;
  model: string | null;
  builtAt: string;
  schemaVersion: number;
  /** SHA-256 of the canonical, authoritative records used to build the table. */
  recordsDigest: string;
  recordCount: number;
  /** SHA-256 of every persisted search-relevant field, including dense vectors. */
  tableDigest: string;
}

export interface SpecIndexFreshness {
  builtAt: string | null;
  tracking: 'tracked' | 'unavailable';
  changedFileCount: number | null;
  changedFiles: string[];
  changedFilesTruncated?: boolean;
}

interface SpecFreshnessReceipt {
  schemaVersion: 1;
  indexBuiltAt: string;
  changedFiles: string[];
}

type SpecMetaState =
  | { kind: 'missing' }
  | { kind: 'legacy'; meta: Omit<SpecIndexMeta, 'recordsDigest' | 'recordCount' | 'tableDigest'> }
  | { kind: 'current'; meta: SpecIndexMeta }
  | { kind: 'malformed' };

function specMetaPath(outputDir: string): string {
  return join(outputDir, META_FILE);
}

function specFreshnessPath(outputDir: string): string {
  return join(outputDir, FRESHNESS_FILE);
}

function hasControlCharacters(value: string): boolean {
  return [...value].some(character => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  });
}

async function acquireSpecIndexLock(outputDir: string): Promise<() => Promise<void>> {
  const result = await acquireLockAt(outputDir, SPEC_INDEX_LOCK_FILE, {
    bestEffortAfterMaxWait: false,
    maxWaitMs: Number.POSITIVE_INFINITY,
  });
  if (isLockHeld(result)) throw new Error('spec-index lock acquisition ended without ownership');
  return result.release;
}

function readSpecFreshnessReceipt(outputDir: string): SpecFreshnessReceipt | null {
  try {
    const path = specFreshnessPath(outputDir);
    if (statSync(path).size > FRESHNESS_MAX_BYTES) return null;
    const value = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    if (!value || typeof value !== 'object') return null;
    const receipt = value as Record<string, unknown>;
    if (receipt.schemaVersion !== 1 || typeof receipt.indexBuiltAt !== 'string'
      || !Array.isArray(receipt.changedFiles)
      || !receipt.changedFiles.every(file => typeof file === 'string'
        && Buffer.byteLength(file) <= FRESHNESS_MAX_PATH_BYTES
        && !isAbsolute(file)
        && !file.split(/[\\/]/).includes('..')
        && !hasControlCharacters(file))) return null;
    return receipt as unknown as SpecFreshnessReceipt;
  } catch {
    return null;
  }
}

function specSearchPredicate(domain?: string, section?: string): string | null {
  const clauses: string[] = [];
  if (domain) clauses.push(`\`domain\` = '${domain.replace(/'/g, "''")}'`);
  if (section) clauses.push(`\`section\` = '${section.replace(/'/g, "''")}'`);
  return clauses.length > 0 ? clauses.join(' AND ') : null;
}

function isLegacySpecMeta(
  value: unknown,
): value is Omit<SpecIndexMeta, 'recordsDigest' | 'recordCount' | 'tableDigest'> {
  if (!value || typeof value !== 'object') return false;
  const meta = value as Record<string, unknown>;
  return meta.schemaVersion === 1
    && typeof meta.hasEmbeddings === 'boolean'
    && typeof meta.dim === 'number' && Number.isInteger(meta.dim) && meta.dim >= 0
    && (typeof meta.model === 'string' || meta.model === null)
    && typeof meta.builtAt === 'string'
    && (meta.hasEmbeddings ? meta.dim > 0 : meta.dim === 0 && meta.model === null);
}

function isCurrentSpecMeta(value: unknown): value is SpecIndexMeta {
  if (!value || typeof value !== 'object') return false;
  const meta = value as Record<string, unknown>;
  return meta.schemaVersion === META_SCHEMA_VERSION
    && typeof meta.hasEmbeddings === 'boolean'
    && typeof meta.dim === 'number' && Number.isInteger(meta.dim) && meta.dim >= 0
    && (typeof meta.model === 'string' || meta.model === null)
    && typeof meta.builtAt === 'string'
    && typeof meta.recordsDigest === 'string' && /^[a-f0-9]{64}$/.test(meta.recordsDigest)
    && typeof meta.recordCount === 'number' && Number.isInteger(meta.recordCount) && meta.recordCount > 0
    && typeof meta.tableDigest === 'string' && /^[a-f0-9]{64}$/.test(meta.tableDigest)
    && (meta.hasEmbeddings ? meta.dim > 0 : meta.dim === 0 && meta.model === null);
}

/** Missing is a legitimate legacy state; malformed or foreign-shaped bytes are not. */
function readSpecMeta(outputDir: string): SpecMetaState {
  const path = specMetaPath(outputDir);
  if (!existsSync(path)) return { kind: 'missing' };
  try {
    const value: unknown = JSON.parse(readFileSync(path, 'utf-8'));
    if (isCurrentSpecMeta(value)) return { kind: 'current', meta: value };
    if (isLegacySpecMeta(value)) return { kind: 'legacy', meta: value };
    return { kind: 'malformed' };
  } catch {
    return { kind: 'malformed' };
  }
}

async function writeSpecMeta(outputDir: string, meta: SpecIndexMeta): Promise<void> {
  await atomicWriteFile(specMetaPath(outputDir), JSON.stringify(meta, null, 2) + '\n');
  // Establish an explicit zero point. If this second write is interrupted,
  // freshness() reports unavailable rather than claiming a false zero.
  await atomicWriteFile(specFreshnessPath(outputDir), JSON.stringify({
    schemaVersion: 1,
    indexBuiltAt: meta.builtAt,
    changedFiles: [],
  } satisfies SpecFreshnessReceipt, null, 2) + '\n');
}

type AuthoritativeSpecRecord = Omit<SpecRecord, 'vector'>;

/** Order-independent digest of exactly the fields from which the searchable table is derived. */
function digestSpecRecords(records: readonly AuthoritativeSpecRecord[]): string {
  const canonical = records.map(record => JSON.stringify({
    id: record.id,
    domain: record.domain,
    section: record.section,
    title: record.title,
    text: record.text,
    linkedFiles: record.linkedFiles,
  })).sort();
  const hash = createHash('sha256');
  hash.update(`spec-records-v1\n${canonical.length}\n`);
  for (const record of canonical) hash.update(`${Buffer.byteLength(record)}:${record}\n`);
  return hash.digest('hex');
}

function digestPersistedSpecRows(rows: readonly Record<string, unknown>[]): string {
  const canonical = rows.map(row => JSON.stringify({
    id: String(row.id ?? ''),
    domain: String(row.domain ?? ''),
    section: String(row.section ?? ''),
    title: String(row.title ?? ''),
    text: String(row.text ?? ''),
    linkedFiles: String(row.linkedFiles ?? ''),
    vector: row.vector == null ? null : Array.from(row.vector as ArrayLike<number>),
  })).sort();
  const hash = createHash('sha256');
  hash.update(`persisted-spec-records-v1\n${canonical.length}\n`);
  for (const record of canonical) hash.update(`${Buffer.byteLength(record)}:${record}\n`);
  return hash.digest('hex');
}

const verifiedSpecTables = new Map<string, { metaDigest: string; tableVersion: number }>();

/** Test-only: force the next search through the cold verification path. */
export function _resetSpecVectorIndexVerificationCacheForTesting(): void {
  verifiedSpecTables.clear();
}

// Mapping entry shape from .openlore/analysis/mapping.json
interface MappingEntry {
  requirement: string;
  service?: string;
  domain: string;
  specFile?: string;
  functions?: Array<{ name: string; file: string; line?: number; kind?: string; confidence?: string }>;
}

// ============================================================================
// MARKDOWN PARSER
// ============================================================================

interface ParsedSection {
  section: string;
  title: string;
  content: string;
  requirementKey?: string; // slugified requirement name for mapping lookup
}

/**
 * Parse a spec Markdown file into logical sections.
 * Each H2 becomes a section; H3 within Requirements becomes individual items.
 */
function parseSpecFile(markdown: string): ParsedSection[] {
  const lines = markdown.split('\n');
  const results: ParsedSection[] = [];

  let currentH2 = '';
  let currentH2Section = '';
  let currentH3 = '';
  let currentH3Key = '';
  let buffer: string[] = [];

  const flush = () => {
    const content = buffer.join('\n').trim();
    if (!content) return;

    if (currentH3 && currentH2Section === 'requirements') {
      results.push({
        section: 'requirements',
        title: currentH3,
        content,
        requirementKey: currentH3Key,
      });
    } else if (currentH2) {
      results.push({
        section: currentH2Section,
        title: currentH2,
        content,
      });
    }
    buffer = [];
  };

  for (const line of lines) {
    // Skip generator comment lines
    if (line.startsWith('> Generated by')) continue;
    if (line.startsWith('> Source files:')) continue;

    const h2Match = line.match(/^## (.+)/);
    const h3Match = line.match(/^### (.+)/);

    if (h2Match) {
      flush();
      currentH2 = h2Match[1].trim();
      currentH2Section = slugifySection(currentH2);
      currentH3 = '';
      currentH3Key = '';
    } else if (h3Match && currentH2Section === 'requirements') {
      flush();
      currentH3 = h3Match[1].trim();
      currentH3Key = slugifyRequirement(currentH3);
    } else if (!line.startsWith('# ')) {
      // Skip H1 (spec title handled by filename/domain)
      buffer.push(line);
    }
  }
  flush();

  return results;
}

function slugifySection(title: string): string {
  const lower = title.toLowerCase();
  if (lower.includes('purpose')) return 'purpose';
  if (lower.includes('entit')) return 'entities';
  if (lower.includes('requirement')) return 'requirements';
  if (lower.includes('design')) return 'design';
  if (lower.includes('architecture')) return 'architecture';
  if (lower.includes('sub-component') || lower.includes('subcomponent')) return 'subcomponents';
  return lower.replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

/** Extract requirement key from "Requirement: MapSomething" -> "mapSomething" */
function slugifyRequirement(title: string): string {
  const withoutPrefix = title.replace(/^Requirement:\s*/i, '').trim();
  // camelCase -> first char lowercase
  return withoutPrefix.charAt(0).toLowerCase() + withoutPrefix.slice(1);
}

// ============================================================================
// MAPPING INDEX
// ============================================================================

/**
 * Build a lookup: "domain:requirementKey" -> string[] of source files.
 * Filters out wildcard entries (*) and deduplicates.
 */
function buildMappingIndex(mappings: MappingEntry[]): Map<string, string[]> {
  const index = new Map<string, string[]>();
  for (const m of mappings) {
    const key = `${m.domain}:${m.requirement}`;
    const files = (m.functions ?? [])
      .map(f => f.file)
      .filter(f => f && f !== '*');
    if (files.length > 0) {
      const existing = index.get(key) ?? [];
      const merged = [...new Set([...existing, ...files])];
      index.set(key, merged);
    }
  }
  return index;
}

// ============================================================================
// TEXT BUILDER
// ============================================================================

function buildText(domain: string, section: ParsedSection): string {
  const parts = [`[spec:${domain}] ${section.title}`];
  if (section.content) parts.push(section.content);
  return parts.join('\n');
}

export function searchableFieldsForSpecRow(row: Record<string, unknown>): SearchableFields {
  const domain = String(row.domain ?? '');
  const title = String(row.title ?? '');
  const text = String(row.text ?? '');
  const header = `[spec:${domain}] ${title}`;
  const prose = text.startsWith(`${header}\n`) ? text.slice(header.length + 1) : '';
  return {
    symbol: title,
    path: `[spec:${domain}]`,
    doc: prose,
  };
}

// ============================================================================
// ADR PARSER
// ============================================================================

interface AdrRecord {
  id: string;
  domain: string;
  section: string;
  title: string;
  text: string;
  linkedFiles: string;
}

async function findAdrFiles(decisionsDir: string): Promise<string[]> {
  if (!(await fileExists(decisionsDir))) return [];
  try {
    const entries = await readdir(decisionsDir);
    return entries
      .filter((f) => /^adr-\d+.*\.md$/i.test(f))
      .map((f) => join(decisionsDir, f))
      // Same symlink vector as findSpecFiles: an ADR-named link out of the repo.
      .filter((p) => isConfinedPath(decisionsDir, p));
  } catch (error) {
    throw new Error(`Cannot enumerate authoritative decision directory ${decisionsDir}`, { cause: error });
  }
}

async function parseAdrFiles(decisionsDir: string): Promise<AdrRecord[]> {
  const files = await findAdrFiles(decisionsDir);
  const records: AdrRecord[] = [];

  for (const filePath of files) {
    try {
      const content = await readFileConfined(
        decisionsDir,
        relative(decisionsDir, filePath),
        SPEC_ARTIFACT_MAX_BYTES,
        false,
        true,
      );
      const titleMatch = content.match(/^#\s+(ADR-\d+):\s+(.+)$/m);
      if (!titleMatch) continue;
      const adrNum = titleMatch[1];
      const title = titleMatch[2].trim();

      records.push({
        id: `decisions.${adrNum.toLowerCase()}`,
        domain: 'decisions',
        section: adrNum,
        title: `${adrNum}: ${title}`,
        text: `[decision] ${adrNum}: ${title}\n${content}`,
        linkedFiles: '[]',
      });
    } catch (error) {
      throw new Error(
        `Cannot read authoritative decision artifact ${relative(decisionsDir, filePath)}: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }

  return records;
}

// ============================================================================
// SPEC VECTOR INDEX
// ============================================================================

export class SpecVectorIndex {
  /**
   * Discover all spec.md files under specsDir, parse them, enrich with mapping,
   * embed, and write to LanceDB table "specs".
   *
   * @param outputDir  Path to .openlore/analysis/
   * @param specsDir   Path to openspec/specs/ (or any directory containing domain/spec.md files)
   * @param mappingJsonPath  Path to mapping.json (optional -- no enrichment if absent)
   */
  static async build(
    outputDir: string,
    specsDir: string,
    embedSvc: Embedder | null,
    mappingJsonPath?: string,
    decisionsDir?: string
  ): Promise<{ recordCount: number; hasEmbeddings: boolean }> {
    const release = await acquireSpecIndexLock(outputDir);
    try {
      return await SpecVectorIndex._buildLocked(
        outputDir,
        specsDir,
        embedSvc,
        mappingJsonPath,
        decisionsDir,
      );
    } finally {
      await release();
    }
  }

  private static async _buildLocked(
    outputDir: string,
    specsDir: string,
    embedSvc: Embedder | null,
    mappingJsonPath?: string,
    decisionsDir?: string,
  ): Promise<{ recordCount: number; hasEmbeddings: boolean }> {
    const { connect } = await import('@lancedb/lancedb');

    // Load mapping index (optional)
    let mappingIndex = new Map<string, string[]>();
    if (mappingJsonPath && await fileExists(mappingJsonPath)) {
      try {
        const raw = JSON.parse(await readFile(mappingJsonPath, 'utf-8'));
        mappingIndex = buildMappingIndex((raw.mappings ?? []) as MappingEntry[]);
      } catch {
        // non-fatal -- proceed without enrichment
      }
    }

    // Discover spec files — distinguish "directory missing" from "directory
    // present but empty" so callers can tell a misconfig from an unseeded repo.
    const specFiles = await findSpecFiles(specsDir);
    if (specFiles.length === 0) {
      const dirExists = await fileExists(specsDir);
      throw new Error(
        dirExists
          ? `Spec directory ${specsDir} exists but contains no spec.md files — run 'openlore generate', or point openspecPath at your specs`
          : `Spec directory ${specsDir} does not exist — run 'openlore init' (it now detects docs/specs/ and specs/)`
      );
    }

    // Parse all specs into records (without vectors)
    const records: AuthoritativeSpecRecord[] = [];

    for (const specFile of specFiles) {
      const domain = basename(dirname(specFile));
      let markdown: string;
      try {
        markdown = await readFileConfined(
          specsDir,
          relative(specsDir, specFile),
          SPEC_ARTIFACT_MAX_BYTES,
          false,
          true,
        );
      } catch (error) {
        throw new Error(
          `Cannot read authoritative spec artifact ${relative(specsDir, specFile)}: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }

      const sections = parseSpecFile(markdown);

      for (const sec of sections) {
        const reqKey = sec.requirementKey ?? sec.section;
        const mappingKey = `${domain}:${reqKey}`;
        const linkedFiles = mappingIndex.get(mappingKey) ?? [];

        const id = sec.requirementKey
          ? `${domain}.${sec.requirementKey}`
          : `${domain}.${sec.section}`;

        const text = buildText(domain, sec);

        records.push({
          id,
          domain,
          section: sec.section,
          title: sec.title,
          text,
          linkedFiles: JSON.stringify(linkedFiles),
        });
      }
    }

    // Also index ADR files from openspec/decisions/ if decisionsDir provided
    if (decisionsDir) {
      const adrRecords = await parseAdrFiles(decisionsDir);
      records.push(...adrRecords);
    }

    if (records.length === 0) {
      throw new Error('No spec sections could be parsed');
    }

    const dbPath = join(outputDir, DB_FOLDER);
    const recordsDigest = digestSpecRecords(records);
    const metaState = readSpecMeta(outputDir);

    // Reuse is allowed only when both the authoritative inputs and the persisted
    // table agree with the atomically-published metadata. Missing legacy metadata
    // is still readable by search(), but is intentionally rebuilt here because it
    // cannot prove which inputs produced the table.
    if (metaState.kind === 'current'
      && metaState.meta.recordsDigest === recordsDigest
      && metaState.meta.recordCount === records.length
      && metaState.meta.hasEmbeddings === Boolean(embedSvc)
      && metaState.meta.model === (embedSvc?.modelName ?? null)
      && SpecVectorIndex.exists(outputDir)
      && await SpecVectorIndex._tableMatchesDigest(outputDir, metaState.meta)) {
      // A verified no-op rebuild is still an authoritative freshness check.
      // Clear watcher changes that were reverted or did not affect indexed rows.
      await writeSpecMeta(outputDir, metaState.meta);
      return { recordCount: records.length, hasEmbeddings: metaState.meta.hasEmbeddings };
    }

    // ── BM25-only build (no embedding service) ───────────────────────────────
    // Write records without a `vector` column and record hasEmbeddings:false.
    if (!embedSvc) {
      const db = await connect(dbPath);
      const table = await db.createTable(
        TABLE_NAME,
        records as unknown as Record<string, unknown>[],
        { mode: 'overwrite' }
      );
      const rows = await table.query().toArray() as Record<string, unknown>[];
      const meta: SpecIndexMeta = {
        hasEmbeddings: false,
        dim: 0,
        model: null,
        builtAt: new Date().toISOString(),
        schemaVersion: META_SCHEMA_VERSION,
        recordsDigest,
        recordCount: records.length,
        tableDigest: digestPersistedSpecRows(rows),
      };
      await writeSpecMeta(outputDir, meta);
      await SpecVectorIndex._rememberVerifiedTable(outputDir, table, meta);
      return { recordCount: records.length, hasEmbeddings: false };
    }

    // Batch-embed
    const texts = records.map(r => r.text);
    const vectors = await embedSvc.embed(texts);

    if (vectors.length !== records.length) {
      throw new Error(`Embedding count mismatch: expected ${records.length}, got ${vectors.length}`);
    }

    const fullRecords: SpecRecord[] = records.map((r, i) => ({
      ...r,
      vector: vectors[i],
    }));

    // Write to LanceDB (same DB folder, table "specs")
    const db = await connect(dbPath);
    const table = await db.createTable(TABLE_NAME, fullRecords as unknown as Record<string, unknown>[], { mode: 'overwrite' });
    const persistedRows = await table.query().toArray() as Record<string, unknown>[];

    const meta: SpecIndexMeta = {
      hasEmbeddings: true,
      dim: fullRecords[0]?.vector.length ?? 0,
      model: embedSvc.modelName ?? null,
      builtAt: new Date().toISOString(),
      schemaVersion: META_SCHEMA_VERSION,
      recordsDigest,
      recordCount: fullRecords.length,
      tableDigest: digestPersistedSpecRows(persistedRows),
    };
    await writeSpecMeta(outputDir, meta);
    await SpecVectorIndex._rememberVerifiedTable(outputDir, table, meta);

    return { recordCount: fullRecords.length, hasEmbeddings: true };
  }

  /**
   * Semantic search over the spec index.
   */
  static async search(
    outputDir: string,
    query: string,
    embedSvc: Embedder | null | undefined,
    opts: {
      limit?: number;
      domain?: string;
      section?: string;
      /** Internal diagnostic: return the ordinary bounded candidate window before result cutoff. */
      traceCandidates?: boolean;
    } = {}
  ): Promise<SpecSearchResult[]> {
    const { connect } = await import('@lancedb/lancedb');

    const { limit = 10, domain, section, traceCandidates = false } = opts;

    if (!SpecVectorIndex.exists(outputDir)) {
      throw new Error('No spec index found. Run "openlore analyze" first.');
    }

    const dbPath = join(outputDir, DB_FOLDER);
    const db = await connect(dbPath);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const table: any = await db.openTable(TABLE_NAME);

    // ── BM25-only path ─────────────────────────────────────────────────────────
    // Force BM25 when no embedder is available OR the spec index was built
    // without embeddings (no `vector` column). Missing sidecar ⇒ legacy embedded.
    const metaState = readSpecMeta(outputDir);
    const meta = metaState.kind === 'current' || metaState.kind === 'legacy' ? metaState.meta : null;
    if (metaState.kind === 'current'
      && !await SpecVectorIndex._tableMatchesDigest(outputDir, metaState.meta, table)) {
      throw new Error('Spec index content does not match its metadata. Run "openlore analyze" to rebuild it.');
    }
    // Schema-v1 and missing metadata cannot prove table shape. Probe the actual
    // table before selecting ANN so a missing/corrupt sidecar on a BM25-only
    // table never turns into a nearestTo() call against a nonexistent column.
    const indexHasEmbeddings = metaState.kind === 'current'
      ? metaState.meta.hasEmbeddings
      : (await table.schema()).fields.some((field: { name: string }) => field.name === 'vector');
    if (!embedSvc || !indexHasEmbeddings) {
      return SpecVectorIndex._bm25Only(table, query, limit, domain, section, traceCandidates);
    }

    let queryVector: number[];
    try {
      [queryVector] = await embedSvc.embed([query]);
    } catch {
      // Embedder unreachable / unavailable — degrade to BM25 rather than erroring.
      return SpecVectorIndex._bm25Only(table, query, limit, domain, section, traceCandidates);
    }
    if (!queryVector) throw new Error('Failed to embed query');

    // Dimension safety-net: a model switch without a spec-index rebuild would make
    // the query vector's dimension disagree with the stored vectors and crash ANN.
    if (meta && meta.dim > 0 && queryVector.length !== meta.dim) {
      return SpecVectorIndex._bm25Only(table, query, limit, domain, section, traceCandidates);
    }

    const fetchLimit = Math.min(limit * 10, 500);
    let denseQuery = table.query().nearestTo(queryVector);
    const densePredicate = specSearchPredicate(domain, section);
    // where() is a LanceDB prefilter by default, so filtered rows participate in
    // ANN recall instead of being discarded after a bounded fetch.
    if (densePredicate) denseQuery = denseQuery.where(densePredicate);
    const rows = await denseQuery.limit(fetchLimit).toArray();

    const filtered = rows
      .filter((row: Record<string, unknown>) => {
        if (domain && (row.domain as string) !== domain) return false;
        if (section && (row.section as string) !== section) return false;
        return true;
      })
      .slice(0, traceCandidates ? undefined : limit);

    return filtered.map((row: Record<string, unknown>) => {
      let linkedFiles: string[] = [];
      try {
        linkedFiles = JSON.parse(row.linkedFiles as string) as string[];
      } catch { /* ignore */ }

      return {
        record: {
          id: row.id as string,
          domain: row.domain as string,
          section: row.section as string,
          title: row.title as string,
          text: row.text as string,
          linkedFiles,
        },
        score: row._distance as number,
        scoreKind: 'cosine_distance' as const,
        matchEvidence: vectorMatchEvidence(3),
      };
    });
  }

  /**
   * BM25-only search over the spec corpus: used when no embedding service is
   * available or the index was built without embeddings. Scores the full
   * corpus with BM25 and returns the top `limit` matching sections.
   */
  private static async _bm25Only(
    table: { query(): { toArray(): Promise<Record<string, unknown>[]> } },
    query: string,
    limit: number,
    domain?: string,
    section?: string,
    traceCandidates = false,
  ): Promise<SpecSearchResult[]> {
    const allRows = await table.query().toArray() as Record<string, unknown>[];
    const corpus = buildBm25Corpus(
      allRows.map(r => ({ id: r.id as string, text: r.text as string }))
    );
    const queryTokens = tokenize(query);
    const rowById = new Map(allRows.map(r => [r.id as string, r]));

    return corpus.docs
      .map((_, i) => ({ idx: i, score: bm25Score(corpus, queryTokens, i) }))
      .filter(({ score }) => score > 0)
      // Deterministic ordering: score desc, ties broken by id asc.
      .sort((a, b) => b.score - a.score || (corpus.docs[a.idx].id < corpus.docs[b.idx].id ? -1 : 1))
      .map(({ idx, score }) => {
        const row = rowById.get(corpus.docs[idx].id);
        return row ? { row, idx, score } : null;
      })
      .filter((x): x is { row: Record<string, unknown>; idx: number; score: number } => x !== null)
      .filter(({ row }) => {
        if (domain && (row.domain as string) !== domain) return false;
        if (section && (row.section as string) !== section) return false;
        return true;
      })
      .slice(0, traceCandidates ? limit * 3 : limit)
      .map(({ row, idx, score }) => {
        let linkedFiles: string[] = [];
        try {
          linkedFiles = JSON.parse(row.linkedFiles as string) as string[];
        } catch { /* ignore */ }
        return {
          record: {
            id: row.id as string,
            domain: row.domain as string,
            section: row.section as string,
            title: row.title as string,
            text: row.text as string,
            linkedFiles,
          },
          score,
          scoreKind: 'bm25' as const,
          matchEvidence: bm25MatchEvidence(corpus, queryTokens, idx, searchableFieldsForSpecRow(row), 1),
        };
      });
  }

  /**
   * Record spec files changed since the current index build. The receipt is
   * versioned and tied to builtAt, so a later full build makes an older receipt
   * inert without requiring a racy delete.
   */
  static async noteSpecFilesChanged(outputDir: string, files: string[]): Promise<void> {
    const release = await acquireSpecIndexLock(outputDir);
    try {
      const state = readSpecMeta(outputDir);
      if (state.kind !== 'current' && state.kind !== 'legacy') return;
      const builtAt = state.meta.builtAt;
      const previous = readSpecFreshnessReceipt(outputDir);
      const changedFiles = new Set(
        previous?.indexBuiltAt === builtAt ? previous.changedFiles : [],
      );
      for (const file of files) changedFiles.add(file.split('\\').join('/'));
      await atomicWriteFile(specFreshnessPath(outputDir), JSON.stringify({
        schemaVersion: 1,
        indexBuiltAt: builtAt,
        changedFiles: [...changedFiles].sort(),
      } satisfies SpecFreshnessReceipt, null, 2) + '\n');
    } finally {
      await release();
    }
  }

  /** Honest spec-index freshness for serving; malformed/stale receipts report unavailable. */
  static freshness(outputDir: string): SpecIndexFreshness | null {
    const state = readSpecMeta(outputDir);
    if (state.kind !== 'current' && state.kind !== 'legacy') {
      return existsSync(join(outputDir, DB_FOLDER, `${TABLE_NAME}.lance`))
        ? { builtAt: null, tracking: 'unavailable', changedFileCount: null, changedFiles: [] }
        : null;
    }
    const receipt = readSpecFreshnessReceipt(outputDir);
    if (!receipt || receipt.indexBuiltAt !== state.meta.builtAt) {
      return {
        builtAt: state.meta.builtAt,
        tracking: 'unavailable',
        changedFileCount: null,
        changedFiles: [],
      };
    }
    const changedFiles = [...receipt.changedFiles].sort();
    return {
      builtAt: state.meta.builtAt,
      tracking: 'tracked',
      changedFileCount: changedFiles.length,
      changedFiles: changedFiles.slice(0, FRESHNESS_RETURNED_FILES),
      ...(changedFiles.length > FRESHNESS_RETURNED_FILES ? { changedFilesTruncated: true } : {}),
    };
  }

  /**
   * Returns true if the spec index table exists.
   */
  static exists(outputDir: string): boolean {
    // LanceDB stores each table as a subfolder inside the DB folder
    if (!existsSync(join(outputDir, DB_FOLDER, `${TABLE_NAME}.lance`))) return false;
    return readSpecMeta(outputDir).kind !== 'malformed';
  }

  private static async _rememberVerifiedTable(
    outputDir: string,
    table: { version(): Promise<number> },
    meta: SpecIndexMeta,
  ): Promise<void> {
    verifiedSpecTables.set(join(outputDir, DB_FOLDER), {
      metaDigest: JSON.stringify(meta),
      tableVersion: await table.version(),
    });
  }

  private static async _tableMatchesDigest(
    outputDir: string,
    meta: SpecIndexMeta,
    existingTable?: { version(): Promise<number>; query(): { toArray(): Promise<Record<string, unknown>[]> } },
  ): Promise<boolean> {
    try {
      let table = existingTable;
      if (!table) {
        const { connect } = await import('@lancedb/lancedb');
        const db = await connect(join(outputDir, DB_FOLDER));
        table = await db.openTable(TABLE_NAME);
      }
      const dbPath = join(outputDir, DB_FOLDER);
      const metaDigest = JSON.stringify(meta);
      // Lance publishes supported mutations as immutable table versions. This
      // lookup is constant-cost; recursively statting every fragment made every
      // warm query scale with the physical table layout.
      const tableVersion = await table.version();
      const cached = verifiedSpecTables.get(dbPath);
      if (cached?.metaDigest === metaDigest && cached.tableVersion === tableVersion) return true;

      const rows = await table.query().toArray() as Record<string, unknown>[];
      if (rows.length !== meta.recordCount) return false;
      const vectorLengths = rows.map(row => row.vector == null
        ? null
        : Array.from(row.vector as ArrayLike<number>).length);
      if (meta.hasEmbeddings) {
        if (meta.dim <= 0 || vectorLengths.some(length => length !== meta.dim)) return false;
      } else if (meta.dim !== 0 || vectorLengths.some(length => length !== null)) {
        return false;
      }
      const records = rows.map(row => ({
        id: String(row.id ?? ''),
        domain: String(row.domain ?? ''),
        section: String(row.section ?? ''),
        title: String(row.title ?? ''),
        text: String(row.text ?? ''),
        linkedFiles: String(row.linkedFiles ?? ''),
      }));
      const matches = digestSpecRecords(records) === meta.recordsDigest
        && digestPersistedSpecRows(rows) === meta.tableDigest;
      if (matches) {
        verifiedSpecTables.set(dbPath, { metaDigest, tableVersion });
      }
      return matches;
    } catch {
      return false;
    }
  }
}

// ============================================================================
// HELPERS
// ============================================================================

async function findSpecFiles(specsDir: string): Promise<string[]> {
  if (!await fileExists(specsDir)) return [];
  const results: string[] = [];

  let entries: string[];
  try {
    entries = await readdir(specsDir);
  } catch {
    return [];
  }

  for (const entry of entries) {
    const domainDir = join(specsDir, entry);
    const specFile = join(domainDir, 'spec.md');
    // `fileExists` stats THROUGH a symlink, so a committed
    // `openspec/specs/notes/spec.md -> ~/private.md` would otherwise be read and
    // chunked into the vector index — an artifact `openlore export` ships.
    if (!isConfinedPath(specsDir, specFile)) continue;
    if (await fileExists(specFile)) {
      results.push(specFile);
    }
  }

  return results;
}
