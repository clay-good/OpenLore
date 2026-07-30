/**
 * Database Schema Extractor
 *
 * Parses ORM schema definitions from source files using regex-based analysis.
 * Supports Prisma, TypeORM, Drizzle ORM, and SQLAlchemy.
 *
 * Audit fields (createdAt, updatedAt, created_at, updated_at, deletedAt,
 * deleted_at) are excluded from field lists to keep output concise.
 *
 * Uses regex-based analysis without requiring tree-sitter.
 */

import { extname, relative } from 'node:path';
import { getSkeletonContent } from './code-shaper.js';
import { mapFilesBounded, readSourceCapped } from './bounded-file-scan.js';

// ============================================================================
// TYPES
// ============================================================================

export interface SchemaField {
  name: string;
  type: string;
  nullable: boolean;
}

export type OrmType = 'prisma' | 'typeorm' | 'drizzle' | 'sqlalchemy' | 'jpa' | 'unknown';

export interface SchemaTable {
  /** Model / table name */
  name: string;
  /** Path relative to project root */
  file: string;
  /** ORM that owns this schema */
  orm: OrmType;
  /** Extracted fields (audit fields excluded) */
  fields: SchemaField[];
  /** 1-based line of the model declaration */
  line: number;
}

// ============================================================================
// AUDIT FIELD FILTER
// ============================================================================

const AUDIT_FIELD_NAMES = new Set([
  'createdAt', 'updatedAt', 'deletedAt',
  'created_at', 'updated_at', 'deleted_at',
  'createdBy', 'updatedBy', 'created_by', 'updated_by',
]);

function isAuditField(name: string): boolean {
  return AUDIT_FIELD_NAMES.has(name);
}

// ============================================================================
// HELPERS
// ============================================================================

function lineOfIndex(source: string, index: number): number {
  return source.slice(0, index).split('\n').length;
}

// ============================================================================
// PRISMA PARSER (.prisma files)
// ============================================================================

// model User { ... }
// Body EXCLUDES `{` rather than being length-bounded: a Prisma model body contains no
// nested braces, so excluding the opener makes the scan stop at the next `model X {`
// instead of running to EOF (measured 2ms vs 4.8s for the bounded form on a hostile
// file) — and, unlike a bound, it cannot silently drop a genuinely large model.
const PRISMA_MODEL_RE = /^model\s+(\w+)\s*\{([^{}]+)\}/gm;
// field line: fieldName  FieldType? @...
const PRISMA_FIELD_RE = /^\s{1,4}(\w+)\s+(\w+)(\?)?/m;

function parsePrisma(source: string, rel: string): SchemaTable[] {
  const tables: SchemaTable[] = [];
  const modelRe = new RegExp(PRISMA_MODEL_RE.source, PRISMA_MODEL_RE.flags);
  let m: RegExpExecArray | null;

  while ((m = modelRe.exec(source)) !== null) {
    const name = m[1];
    const body = m[2];
    const line = lineOfIndex(source, m.index);
    const fields: SchemaField[] = [];

    for (const rawLine of body.split('\n')) {
      const fm = PRISMA_FIELD_RE.exec(rawLine);
      if (!fm) continue;
      const fieldName = fm[1];
      if (fieldName.startsWith('@') || fieldName === '@@') continue;
      if (isAuditField(fieldName)) continue;
      fields.push({
        name: fieldName,
        type: fm[2],
        nullable: fm[3] === '?',
      });
    }

    tables.push({ name, file: rel, orm: 'prisma', fields, line });
  }

  return tables;
}

// ============================================================================
// TYPEORM PARSER (.ts files with @Entity)
// ============================================================================

// @Entity() ... class ClassName { ... }
// We capture class name after @Entity decorator region.
const TYPEORM_ENTITY_RE = /@Entity\s*\([^)]{0,400}\)[^]{0,20000}?class\s+(\w+)/g;
// @Column() / @PrimaryGeneratedColumn() etc before fieldName: FieldType
const TYPEORM_COLUMN_RE = /@(?:Column|PrimaryGeneratedColumn|PrimaryColumn|CreateDateColumn|UpdateDateColumn|DeleteDateColumn|ManyToOne|OneToMany|ManyToMany|OneToOne|JoinColumn|JoinTable)\s*\([^)]*\)\s*\n\s*(\w+)\s*[?!]?\s*:\s*([^;\n]+)/g;
const TYPEORM_CLASS_BODY_RE = /class\s+\w+[^{]*\{([^]*?)^}/m;

function parseTypeOrm(source: string, rel: string): SchemaTable[] {
  const tables: SchemaTable[] = [];
  const entityRe = new RegExp(TYPEORM_ENTITY_RE.source, TYPEORM_ENTITY_RE.flags);
  let em: RegExpExecArray | null;

  while ((em = entityRe.exec(source)) !== null) {
    const name = em[1];
    const line = lineOfIndex(source, em.index);
    const fields: SchemaField[] = [];

    // Extract class body starting from the match
    const afterMatch = source.slice(em.index);
    const bodyMatch = TYPEORM_CLASS_BODY_RE.exec(afterMatch);
    if (bodyMatch) {
      const body = bodyMatch[1];
      const colRe = new RegExp(TYPEORM_COLUMN_RE.source, TYPEORM_COLUMN_RE.flags);
      let cm: RegExpExecArray | null;
      while ((cm = colRe.exec(body)) !== null) {
        const fieldName = cm[1];
        if (isAuditField(fieldName)) continue;
        fields.push({
          name: fieldName,
          type: cm[2].trim().replace(/;.*$/, ''),
          nullable: cm[2].includes('null') || false,
        });
      }
    }

    tables.push({ name, file: rel, orm: 'typeorm', fields, line });
  }

  return tables;
}

// ============================================================================
// DRIZZLE ORM PARSER (.ts files)
// ============================================================================

// export const users = pgTable('users', { ... })
const DRIZZLE_TABLE_RE = /(?:export\s+(?:const|let)\s+(\w+)\s*=\s*)?(?:pgTable|mysqlTable|sqliteTable)\s*\(\s*['"`](\w+)['"`]\s*,\s*\{([^}]{0,20000})\}/g;
// fieldName: columnType(...)
const DRIZZLE_FIELD_RE = /^\s{1,6}(\w+)\s*:\s*([\w.]+)\s*\(/m;

function parseDrizzle(source: string, rel: string): SchemaTable[] {
  const tables: SchemaTable[] = [];
  const tableRe = new RegExp(DRIZZLE_TABLE_RE.source, DRIZZLE_TABLE_RE.flags);
  let m: RegExpExecArray | null;

  while ((m = tableRe.exec(source)) !== null) {
    // Prefer the table name literal (m[2]) over the variable name (m[1])
    const name = m[2] || m[1] || 'unknown';
    const body = m[3];
    const line = lineOfIndex(source, m.index);
    const fields: SchemaField[] = [];

    for (const rawLine of body.split('\n')) {
      const fm = DRIZZLE_FIELD_RE.exec(rawLine);
      if (!fm) continue;
      const fieldName = fm[1];
      if (isAuditField(fieldName)) continue;
      fields.push({
        name: fieldName,
        type: fm[2],
        nullable: rawLine.includes('.nullable()') || rawLine.includes('$default'),
      });
    }

    tables.push({ name, file: rel, orm: 'drizzle', fields, line });
  }

  return tables;
}

// ============================================================================
// SQLALCHEMY PARSER (.py files)
// ============================================================================

// class User(Base): or class User(db.Model):
const SQLALCHEMY_MODEL_RE = /^class\s+(\w+)\s*\([^)]*(?:Base|db\.Model|DeclarativeBase)[^)]*\)\s*:/gm;
// column_name = Column(Type, ...)
const SQLALCHEMY_COLUMN_RE = /^\s{4}(\w+)\s*=\s*(?:mapped_column|Column)\s*\(\s*([^,)]+)/m;
// nullable: nullable=True (default) or nullable=False
const SQLALCHEMY_NULLABLE_RE = /nullable\s*=\s*(True|False)/;

function parseSqlAlchemy(source: string, rel: string): SchemaTable[] {
  const tables: SchemaTable[] = [];
  const classRe = new RegExp(SQLALCHEMY_MODEL_RE.source, SQLALCHEMY_MODEL_RE.flags);
  let cm: RegExpExecArray | null;

  while ((cm = classRe.exec(source)) !== null) {
    const name = cm[1];
    const line = lineOfIndex(source, cm.index);
    const fields: SchemaField[] = [];

    // Capture up to next class or end of file
    const rest = source.slice(cm.index + cm[0].length);
    const nextClassIdx = rest.search(/^class\s+\w+/m);
    const classBody = nextClassIdx >= 0 ? rest.slice(0, nextClassIdx) : rest;

    for (const rawLine of classBody.split('\n')) {
      const fm = SQLALCHEMY_COLUMN_RE.exec(rawLine);
      if (!fm) continue;
      const fieldName = fm[1];
      if (fieldName.startsWith('_') || isAuditField(fieldName)) continue;
      const nullableMatch = SQLALCHEMY_NULLABLE_RE.exec(rawLine);
      // SQLAlchemy columns are nullable by default
      const nullable = nullableMatch ? nullableMatch[1] === 'True' : true;
      fields.push({
        name: fieldName,
        type: fm[2].trim().replace(/[,)].*/s, ''),
        nullable,
      });
    }

    tables.push({ name, file: rel, orm: 'sqlalchemy', fields, line });
  }

  return tables;
}

// ============================================================================
// JPA / HIBERNATE PARSER (.java files)
// ============================================================================

// @Entity / @MappedSuperclass marks a persistent class. javax.* and jakarta.*
// both use the bare annotation name at the use site.
const JPA_ENTITY_CLASS_RE = /@(?:Entity|MappedSuperclass)\b[\s\S]*?\bclass\s+(\w+)/;
// @Table(name = "owners") → explicit table name (otherwise the class name).
const JPA_TABLE_RE = /@Table\s*\([^)]*\bname\s*=\s*"([^"]+)"/;
// A persistent field: `[modifiers] Type name [= …];` at class-body level.
// Methods never match because a `;`/`=` must follow the name (methods have `(`).
// The type capture excludes SPACE. With ' ' inside the class and `\s+` immediately
// after it, every space was claimable by either side — an ambiguity that, combined
// with the `(?:final\s+|…)*` prefix, made a long `private final final …` line
// quadratic. Multi-word generic types still match via the explicit space group.
const JPA_FIELD_RE =
  /^(?:private|protected|public)\s+(?:final\s+|transient\s+|volatile\s+)*([\w.<>[\],]+(?:\s+[\w.<>[\],]+)*?)\s+(\w+)\s*[;=]/;

/**
 * Parse JPA / Hibernate entities from a Java source file. Captures the table
 * name (from @Table or the class name) and the declared instance fields, with
 * a best-effort nullable flag (JPA columns default to nullable unless marked
 * @Id / @NotNull / @NotBlank / nullable = false). @Transient and static fields
 * are skipped — they are not persisted.
 */
function parseJpaEntity(source: string, rel: string): SchemaTable[] {
  const classMatch = source.match(JPA_ENTITY_CLASS_RE);
  if (!classMatch) return [];

  const name = classMatch[1];
  const tableMatch = source.match(JPA_TABLE_RE);
  const line = lineOfIndex(source, classMatch.index ?? 0);

  const lines = source.split('\n');
  const startLine = source.slice(0, classMatch.index ?? 0).split('\n').length - 1;
  const fields: SchemaField[] = [];
  const seen = new Set<string>();

  let depth = 0;
  let started = false;
  let pendingAnn: string[] = [];

  for (let i = startLine; i < lines.length; i++) {
    const lineText = lines[i];
    const trimmed = lineText.trim();

    // Only inspect declarations directly inside the class body (depth 1), so
    // calls and locals inside method bodies (depth ≥ 2) are ignored.
    if (depth === 1 && trimmed) {
      // Peel leading annotations into pendingAnn. They may be on their own line
      // OR inline with the declaration (`@Id private Long id;`), so we strip them
      // and then test whatever remains as a field — otherwise inline-annotated
      // fields (very common, e.g. the @Id primary key) would be lost.
      let rest = trimmed;
      let am: RegExpMatchArray | null;
      while ((am = rest.match(/^@[\w.]+(?:\([^)]*\))?\s*/))) {
        pendingAnn.push(am[0].trim());
        rest = rest.slice(am[0].length);
      }

      if (rest) {
        const fieldMatch = rest.match(JPA_FIELD_RE);
        const isStatic = /\bstatic\b/.test(rest);
        const isTransient = /@Transient\b/.test(pendingAnn.join(' '));
        if (fieldMatch && !isStatic && !isTransient) {
          const fieldName = fieldMatch[2];
          if (!isAuditField(fieldName) && !seen.has(fieldName)) {
            seen.add(fieldName);
            const ann = pendingAnn.join(' ');
            const nullable = !(
              /@(?:Id|NotNull|NotBlank|NotEmpty)\b/.test(ann) || /nullable\s*=\s*false/.test(ann)
            );
            fields.push({ name: fieldName, type: fieldMatch[1].trim(), nullable });
          }
        }
        pendingAnn = [];
      }
      // else: the line was pure annotation(s) — keep pendingAnn for the next line.
    }

    const opens = (lineText.match(/\{/g) ?? []).length;
    const closes = (lineText.match(/\}/g) ?? []).length;
    depth += opens - closes;
    if (opens > 0) started = true;
    if (started && depth <= 0) break;
  }

  return [{ name: tableMatch ? tableMatch[1] : name, file: rel, orm: 'jpa', fields, line }];
}

// ============================================================================
// PUBLIC API
// ============================================================================

/**
 * Extract database schema tables from a list of absolute file paths.
 *
 * @param filePaths - Absolute paths to source files
 * @param rootDir   - Project root used to compute relative paths in output
 */
export async function extractSchemas(
  filePaths: string[],
  rootDir: string
): Promise<SchemaTable[]> {
  // Per-file-then-flatten, over a BOUNDED scan. Returning each file's tables and flattening in
  // `filePaths` order keeps the inventory a pure function of the file list; pushing into a shared
  // array from inside the callbacks appended in I/O-completion order, which made the artifact's
  // bytes depend on disk timing (change: fix-artifact-output-determinism) and would additionally
  // have made the order depend on the scan's concurrency.
  const perFile = await mapFilesBounded(filePaths, async (filePath): Promise<SchemaTable[]> => {
    const ext = extname(filePath).toLowerCase();
    const rel = relative(rootDir, filePath);

    const raw = await readSourceCapped(filePath);
    if (raw === null) return [];

    // Java entities are parsed from raw source — annotations and field
    // declarations must survive intact (the TS/Py skeletonizer would mangle them).
    if (ext === '.java') {
      return /@(?:Entity|MappedSuperclass)\b/.test(raw) ? parseJpaEntity(raw, rel) : [];
    }

    const source = getSkeletonContent(raw, ext === '.py' ? 'python' : 'typescript');

    if (ext === '.prisma') {
      return parsePrisma(source, rel);
    } else if (ext === '.py' && (source.includes('Column(') || source.includes('mapped_column('))) {
      return parseSqlAlchemy(source, rel);
    } else if (ext === '.ts' || ext === '.tsx') {
      if (source.includes('@Entity(') || source.includes('@Entity()')) {
        return parseTypeOrm(source, rel);
      } else if (/pgTable|mysqlTable|sqliteTable/.test(source)) {
        return parseDrizzle(source, rel);
      }
    }
    return [];
  });

  return perFile.flat();
}

/**
 * Summarise schema tables by ORM for display / artifact embedding.
 */
export function summarizeSchemas(
  tables: SchemaTable[]
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const t of tables) {
    counts[t.orm] = (counts[t.orm] ?? 0) + 1;
  }
  return counts;
}
