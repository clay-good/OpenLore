/**
 * Kotlin data-model schemas (change: add-kotlin-schema-inventory, issue #546).
 *
 * JPA and Hibernate entities, Spring Data relational entities, Room entities, and Exposed table
 * objects, each recognized only in a file that imports the library's package. Every model of a
 * file is extracted. A name comes from a string literal; any other expression is recorded as
 * `unresolved`, never guessed.
 *
 * Declarations and their annotations come from the declaration scanner (see `kotlin-http.ts` for
 * why annotation headers are not read from the parse tree).
 */
import { scanKotlinDeclarations, scanKotlinFile, type KotlinSignatureDeclaration } from './kotlin-source.js';

export type KotlinSchemaFramework = 'jpa' | 'spring-data-relational' | 'room' | 'exposed';

export interface KotlinSchemaField {
  name: string;
  type: string;
  nullable: boolean;
  /** A relation this column declares: the kind, and the target type or table when written. */
  relation?: { kind: string; target?: string };
}

export interface KotlinSchemaTable {
  name: string;
  framework: KotlinSchemaFramework;
  fields: KotlinSchemaField[];
  line: number;
  /** Kotlin class or object that declares the model. */
  className: string;
  /** Superclass names, for mapped-superclass resolution across files. */
  extends: string[];
  /** Properties whose type may be an `@Embeddable` of the repository: property → type. */
  embeds: Array<{ property: string; type: string }>;
}

/** Columns of a `@MappedSuperclass` or `@Embeddable`, attached to the entities that use it. */
export interface KotlinSchemaFragment {
  className: string;
  kind: 'mapped-superclass' | 'embeddable';
  fields: KotlinSchemaField[];
}

export interface KotlinSchemaFacts {
  tables: KotlinSchemaTable[];
  fragments: KotlinSchemaFragment[];
  /** Imported persistence libraries that are known and not modeled. */
  unmodeled: string[];
}

export const UNRESOLVED_SCHEMA_NAME = 'unresolved';

const GATES: Record<KotlinSchemaFramework, readonly string[]> = {
  jpa: ['javax.persistence', 'jakarta.persistence'],
  'spring-data-relational': ['org.springframework.data.relational.core.mapping'],
  room: ['androidx.room'],
  exposed: ['org.jetbrains.exposed'],
};

const UNMODELED: ReadonlyArray<[string, string]> = [
  ['org.ktorm', 'ktorm'], ['org.jooq', 'jooq'], ['org.komapper', 'komapper'],
  ['app.cash.sqldelight', 'sqldelight'], ['com.squareup.sqldelight', 'sqldelight'],
];

const RELATIONS = ['OneToMany', 'ManyToOne', 'OneToOne', 'ManyToMany'] as const;
const EXPOSED_TABLE_BASES: ReadonlySet<string> = new Set(['Table', 'IntIdTable', 'LongIdTable', 'UUIDTable', 'IdTable', 'CompositeIdTable']);

interface Annotation { name: string; args: string }

/** Split at commas outside brackets and strings. */
function splitTop(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let angle = 0;
  let quote = false;
  let last = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) { if (c === '\\') i++; else if (c === '"') quote = false; continue; }
    if (c === '"') quote = true;
    else if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === '<') angle++;
    else if (c === '>' && text[i - 1] !== '-' && angle > 0) angle--;
    else if (c === ',' && depth === 0 && angle === 0) { parts.push(text.slice(last, i)); last = i + 1; }
  }
  parts.push(text.slice(last));
  return parts.map(p => p.trim()).filter(Boolean);
}

/** Leading `@Name(args)` annotations of a text, and what follows them. */
function peelAnnotations(text: string): { annotations: Annotation[]; rest: string } {
  const annotations: Annotation[] = [];
  let rest = text.trim();
  for (let guard = 0; guard < 24; guard++) {
    const m = rest.match(/^@(?:[a-z]+:)?(?:[\w.]+\.)?([A-Za-z_]\w*)\s*/);
    if (!m) break;
    let end = m[0].length;
    let args = '';
    if (rest[end] === '(') {
      let depth = 0;
      let i = end;
      for (; i < rest.length; i++) {
        if (rest[i] === '(') depth++;
        else if (rest[i] === ')') { depth--; if (depth === 0) break; }
      }
      args = rest.slice(end + 1, i);
      end = i + 1;
    }
    annotations.push({ name: m[1], args });
    rest = rest.slice(end).trim();
  }
  return { annotations, rest };
}

/** The value of a named argument (or of the first positional one) as written. */
function argument(args: string, names: readonly string[], positional = false): string | undefined {
  for (const part of splitTop(args)) {
    const m = part.match(/^([A-Za-z_]\w*)\s*=(?!=)\s*([\s\S]+)$/);
    if (m) { if (names.includes(m[1])) return m[2].trim(); }
    else if (positional) return part;
  }
  return undefined;
}

/** A string literal's value; `unresolved` for any other expression; undefined when not written. */
function literalName(expression: string | undefined): string | undefined {
  if (expression === undefined) return undefined;
  const m = expression.trim().match(/^"((?:[^"\\$\n]|\\.)*)"$/);
  return m ? m[1] : UNRESOLVED_SCHEMA_NAME;
}

const annotationLines = (d: KotlinSignatureDeclaration): Annotation[] =>
  d.signature.split('\n').filter(l => l.startsWith('@')).flatMap(l => peelAnnotations(l).annotations);

/**
 * Where the primary-constructor parameter list of a class signature starts and ends in `header`,
 * or undefined when the class writes none. The parenthesis must follow the name directly (after
 * type parameters, modifiers, and `constructor`): in `object Orders : Table("orders")` the first
 * parenthesis belongs to the supertype.
 */
function constructorSpan(header: string, d: KotlinSignatureDeclaration): { open: number; close: number } | undefined {
  if (d.kind === 'object') return undefined;
  const name = header.match(new RegExp(`\\b(?:class|interface)\\s+\`?${d.name.replace(/[^\w]/g, '')}\`?`));
  if (!name || name.index === undefined) return undefined;
  let i = name.index + name[0].length;
  const skip = header.slice(i).match(/^\s*(?:<[^>]*>)?\s*(?:(?:@[\w.]+(?:\([^)]*\))?|public|internal|protected|private)\s+)*(?:constructor\s*)?/);
  i += skip ? skip[0].length : 0;
  if (header[i] !== '(') return undefined;
  let depth = 0;
  for (let k = i; k < header.length; k++) {
    if (header[k] === '(') depth++;
    else if (header[k] === ')') { depth--; if (depth === 0) return { open: i, close: k }; }
  }
  return undefined;
}

const headerOf = (d: KotlinSignatureDeclaration): string => d.signature.split('\n').filter(l => !l.startsWith('@')).join(' ');

/** The primary-constructor parameter list of a class signature, or the empty string. */
function constructorParameters(d: KotlinSignatureDeclaration): string {
  const header = headerOf(d);
  const span = constructorSpan(header, d);
  return span ? header.slice(span.open + 1, span.close) : '';
}

/** Supertype names written after the class header. */
function supertypes(d: KotlinSignatureDeclaration): Array<{ name: string; args: string }> {
  const header = headerOf(d);
  const span = constructorSpan(header, d);
  const nameAt = header.search(new RegExp(`\\b${d.name.replace(/[^\w]/g, '')}\\b`));
  const after = header.slice(span ? span.close + 1 : Math.max(0, nameAt) + d.name.length);
  const colon = after.indexOf(':');
  if (colon < 0) return [];
  return splitTop(after.slice(colon + 1)).map(part => {
    const m = part.match(/^([\w.]+)(?:<[^>]*>)?\s*(?:\(([\s\S]*)\))?/);
    return m ? { name: m[1].split('.').pop()!, args: m[2] ?? '' } : { name: part, args: '' };
  });
}

interface Property { name: string; type: string; annotations: Annotation[]; initializer: string }

/** `@A @B val name: Type = init` → its parts; undefined for a plain constructor parameter. */
function propertyOf(text: string, requireBinding: boolean): Property | undefined {
  const { annotations, rest } = peelAnnotations(text);
  const m = rest.match(/^(?:(?:private|protected|internal|public|override|open|final|lateinit|const|vararg)\s+)*(val|var)?\s*(`[^`]+`|[A-Za-z_]\w*)\s*(?::\s*([^=]+?))?\s*(?:=\s*([\s\S]+))?$/);
  if (!m || (requireBinding && !m[1])) return undefined;
  return { name: m[2].replace(/`/g, ''), type: (m[3] ?? '').trim(), annotations, initializer: (m[4] ?? '').trim() };
}

function relationOf(annotations: Annotation[], type: string): KotlinSchemaField['relation'] | undefined {
  const relation = annotations.find(a => (RELATIONS as readonly string[]).includes(a.name));
  if (!relation) return undefined;
  const target = type.replace(/\?$/, '').match(/<\s*([\w.]+)\s*>\s*$/)?.[1] ?? type.replace(/\?$/, '').trim();
  return { kind: relation.name, ...(target ? { target: target.split('.').pop()! } : {}) };
}

/** A column of an annotation-mapped entity, or undefined when the property is not persisted. */
function annotatedField(property: Property, framework: KotlinSchemaFramework): KotlinSchemaField | undefined {
  const has = (name: string): boolean => property.annotations.some(a => a.name === name);
  if (has('Transient') || has('Ignore')) return undefined;
  const columnAnnotation = property.annotations.find(a => a.name === (framework === 'room' ? 'ColumnInfo' : 'Column'))
    ?? (framework === 'jpa' ? property.annotations.find(a => a.name === 'JoinColumn') : undefined);
  const written = columnAnnotation
    ? literalName(argument(columnAnnotation.args, ['name', 'value'], framework === 'spring-data-relational'))
    : undefined;
  const nullableArgument = columnAnnotation ? argument(columnAnnotation.args, ['nullable']) : undefined;
  const nullable = has('Id') || has('PrimaryKey') ? false
    : nullableArgument === 'false' ? false
      : nullableArgument === 'true' ? true
        : property.type.trim().endsWith('?');
  const relation = framework === 'jpa' ? relationOf(property.annotations, property.type) : undefined;
  return { name: written ?? property.name, type: property.type || 'unknown', nullable, ...(relation ? { relation } : {}) };
}

/** Exposed: `val c = integer("name").nullable()` → a column. */
function exposedField(property: Property): KotlinSchemaField | undefined {
  const call = property.initializer.match(/^([a-z][A-Za-z0-9_]*)\s*\(([\s\S]*)$/);
  if (!call) return undefined;
  const args = (() => {
    let depth = 0;
    const text = call[2];
    for (let i = 0; i < text.length; i++) {
      if (text[i] === '(') depth++;
      else if (text[i] === ')') { if (depth === 0) return { inside: text.slice(0, i), chain: text.slice(i + 1) }; depth--; }
    }
    return { inside: text, chain: '' };
  })();
  const first = splitTop(args.inside)[0];
  // A column function takes its name first. A call with no string name is not a column.
  if (first === undefined || !/^"/.test(first.trim())) return undefined;
  const name = literalName(first) ?? property.name;
  const referenced = call[1] === 'reference' || call[1] === 'optReference'
    ? splitTop(args.inside)[1]?.trim()
    : args.chain.match(/\.\s*references\s*\(\s*([\w.]+)/)?.[1];
  return {
    name,
    type: call[1],
    nullable: /\.\s*nullable\s*\(/.test(args.chain) || call[1] === 'optReference',
    ...(referenced ? { relation: { kind: 'reference', target: referenced.split('.')[0] } } : {}),
  };
}

/** The text of a property declaration from its keyword to the end of its statement. */
function statementText(content: string, offset: number): string {
  let depth = 0;
  let quote = false;
  const limit = Math.min(content.length, offset + 600);
  for (let i = offset; i < limit; i++) {
    const c = content[i];
    if (quote) { if (c === '\\') i++; else if (c === '"') quote = false; continue; }
    if (c === '"') quote = true;
    else if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']') depth--;
    else if (c === '}') { if (depth === 0) return content.slice(offset, i); depth--; }
    else if (c === '\n' && depth <= 0 && !/^\s*\./.test(content.slice(i + 1, i + 40))) return content.slice(offset, i);
  }
  return content.slice(offset, limit);
}

const isAuditName = (name: string): boolean =>
  /^(?:created|updated|deleted|modified)(?:_?at|_?on|_?by|At|On|By)$/.test(name);

/** Schemas of one Kotlin file. `content` is the original source. */
export function extractKotlinSchemas(content: string): KotlinSchemaFacts {
  const fqns = scanKotlinFile(content).imports.map(i => i.fqn);
  const imported = (prefixes: readonly string[]): boolean => fqns.some(f => prefixes.some(p => f === p || f.startsWith(`${p}.`)));
  const unmodeled = [...new Set(UNMODELED.filter(([prefix]) => imported([prefix])).map(([, name]) => name))].sort();
  const gates = {
    jpa: imported(GATES.jpa), relational: imported(GATES['spring-data-relational']),
    room: imported(GATES.room), exposed: imported(GATES.exposed),
  };
  if (!gates.jpa && !gates.relational && !gates.room && !gates.exposed) return { tables: [], fragments: [], unmodeled };

  const declarations = scanKotlinDeclarations(content);
  const tables: KotlinSchemaTable[] = [];
  const fragments: KotlinSchemaFragment[] = [];

  for (const d of declarations) {
    if (d.kind !== 'class' && d.kind !== 'object') continue;
    const qualified = d.owner ? `${d.owner}.${d.name}` : d.name;
    const annotations = annotationLines(d);
    const has = (name: string): Annotation | undefined => annotations.find(a => a.name === name);
    const parents = supertypes(d);
    const bodyProperties = declarations
      .filter(m => m.kind === 'property' && m.owner === qualified && m.ownerKind !== 'companion')
      .map(m => {
        const lead = m.signature.split('\n').filter(l => l.startsWith('@')).join(' ');
        return propertyOf(`${lead} ${statementText(content, m.offset)}`, true);
      })
      .filter((p): p is Property => !!p);
    const constructorProperties = splitTop(constructorParameters(d)).map(p => propertyOf(p, true)).filter((p): p is Property => !!p);
    const properties = [...constructorProperties, ...bodyProperties];

    let framework: KotlinSchemaFramework | undefined;
    let name: string | undefined;
    const entity = has('Entity');
    const table = has('Table');
    if (gates.jpa && (entity || has('MappedSuperclass') || has('Embeddable'))) {
      framework = 'jpa';
      name = literalName(table ? argument(table.args, ['name']) : undefined) ?? d.name;
    } else if (gates.room && entity) {
      framework = 'room';
      name = literalName(argument(entity.args, ['tableName'])) ?? d.name;
    } else if (gates.relational && table) {
      framework = 'spring-data-relational';
      name = literalName(argument(table.args, ['name', 'value'], true)) ?? d.name;
    } else if (gates.exposed && d.kind === 'object' && parents.some(p => EXPOSED_TABLE_BASES.has(p.name))) {
      framework = 'exposed';
      const base = parents.find(p => EXPOSED_TABLE_BASES.has(p.name))!;
      const written = splitTop(base.args)[0];
      name = written !== undefined ? literalName(argument(base.args, ['name'], true)) ?? d.name : d.name.replace(/Table$/, '') || d.name;
    }
    if (!framework || name === undefined) continue;

    const fields: KotlinSchemaField[] = [];
    if (framework === 'exposed') {
      const base = parents.find(p => EXPOSED_TABLE_BASES.has(p.name))!.name;
      if (base !== 'Table' && base !== 'CompositeIdTable') fields.push({ name: 'id', type: base.replace(/Table$/, '').toLowerCase() || 'id', nullable: false });
      for (const property of bodyProperties) { const field = exposedField(property); if (field) fields.push(field); }
    } else {
      for (const property of properties) {
        const field = annotatedField(property, framework);
        if (field && !isAuditName(field.name)) fields.push(field);
      }
    }
    const seen = new Set<string>();
    const unique = fields.filter(f => (seen.has(f.name) ? false : (seen.add(f.name), true)));

    if (framework === 'jpa' && !entity) {
      fragments.push({ className: d.name, kind: has('MappedSuperclass') ? 'mapped-superclass' : 'embeddable', fields: unique });
      continue;
    }
    const relations = framework === 'room' && entity
      ? [...entity.args.matchAll(/\bentity\s*=\s*([A-Za-z_]\w*)\s*::\s*class/g)].map(m => m[1])
      : [];
    for (const target of relations) {
      if (!unique.some(f => f.relation?.target === target)) unique.push({ name: `fk:${target}`, type: 'foreign-key', nullable: false, relation: { kind: 'ForeignKey', target } });
    }
    tables.push({
      name, framework, fields: unique, line: d.line, className: d.name,
      extends: framework === 'jpa' ? parents.map(p => p.name) : [],
      embeds: framework === 'jpa'
        ? properties.filter(p => p.annotations.some(a => a.name === 'Embedded') || /^[A-Z]\w*\??$/.test(p.type)).map(p => ({ property: p.name, type: p.type.replace(/\?$/, '') }))
        : [],
    });
  }
  return { tables, fragments, unmodeled };
}

/**
 * Attach the columns of mapped superclasses and embeddables to the entities that extend or embed
 * them, when exactly one fragment of that class name exists in the repository. An embedded type
 * that does not resolve stays a single column named for the property.
 */
export function resolveKotlinSchemaFragments(tables: KotlinSchemaTable[], fragments: KotlinSchemaFragment[]): void {
  const byName = new Map<string, KotlinSchemaFragment[]>();
  for (const fragment of fragments) byName.set(fragment.className, [...(byName.get(fragment.className) ?? []), fragment]);
  const one = (name: string, kind: KotlinSchemaFragment['kind']): KotlinSchemaFragment | undefined => {
    const found = (byName.get(name) ?? []).filter(f => f.kind === kind);
    return found.length === 1 ? found[0] : undefined;
  };
  for (const table of tables) {
    const names = new Set(table.fields.map(f => f.name));
    const add = (field: KotlinSchemaField): void => { if (!names.has(field.name)) { names.add(field.name); table.fields.push(field); } };
    for (const parent of table.extends) for (const field of one(parent, 'mapped-superclass')?.fields ?? []) add(field);
    for (const embed of table.embeds) {
      const fragment = one(embed.type, 'embeddable');
      if (!fragment) continue;
      table.fields = table.fields.filter(f => f.name !== embed.property);
      names.delete(embed.property);
      for (const field of fragment.fields) add(field);
    }
  }
}
