/**
 * The JVM-facing names of Kotlin declarations, derived from syntax alone
 * (change: add-kotlin-java-interop-resolution, issue #546).
 *
 * Java does not call a Kotlin declaration by its Kotlin name. A top-level function lives on a
 * file facade class (`FooKt`), an `object` member is reached through `INSTANCE`, a companion
 * member through `Companion`, and a property through its accessors. This module computes those
 * names so a call written in Java can bind to the Kotlin declaration.
 */
import { scanKotlinDeclarations, type KotlinSignatureDeclaration } from './kotlin-source.js';

/** How a Java call reaches a member. */
export type KotlinJvmAccess =
  /** A static member of the file facade class: `FooKt.name(…)`. */
  | 'facade'
  /** Through the singleton: `Obj.INSTANCE.name(…)`. */
  | 'instance'
  /** Through the companion: `Owner.Companion.name(…)` (or the companion's own name). */
  | 'companion'
  /** Directly on the owner type: `Owner.name(…)` (`@JvmStatic`, `const`, `@JvmField`). */
  | 'static'
  /** On an instance of the owner class: `value.name(…)`. */
  | 'member';

export interface KotlinJvmMember {
  /** The name Java writes. */
  jvmName: string;
  access: KotlinJvmAccess;
  /** Qualified Kotlin owner; undefined for a facade member. */
  owner?: string;
  /** The Kotlin declaration the name stands for. */
  declaration: KotlinSignatureDeclaration;
  /** A property accessor, as opposed to a function. */
  accessor?: 'getter' | 'setter';
}

const annotationArgument = (content: string, declaration: KotlinSignatureDeclaration, annotation: string): string | undefined => {
  if (!declaration.annotations.includes(annotation)) return undefined;
  const lead = content.slice(Math.max(0, declaration.offset - 400), declaration.offset);
  return lead.match(new RegExp(`@(?:[a-z]+:)?${annotation}\\s*\\(\\s*"([^"\\n]{1,200})"\\s*\\)[^@]*$`))?.[1];
};

/**
 * The facade class of a Kotlin file: the `@file:JvmName` value, or the file name with its first
 * letter in upper case, characters that are not valid in an identifier replaced by `_`, and the
 * suffix `Kt`.
 */
export function kotlinFacadeName(filePath: string, content: string): string {
  const explicit = content.slice(0, 4000).match(/@file\s*:\s*JvmName\s*\(\s*"([A-Za-z_$][\w$]{0,200})"\s*\)/)?.[1];
  if (explicit) return explicit;
  const base = (filePath.split('/').pop() ?? filePath).replace(/\.kts?$/i, '');
  const identifier = base.replace(/[^A-Za-z0-9_$]/g, '_');
  return `${identifier.charAt(0).toUpperCase()}${identifier.slice(1)}Kt`;
}

const capitalize = (name: string): string => `${name.charAt(0).toUpperCase()}${name.slice(1)}`;

/** `x` → `getX` / `setX`; a name that starts with `is` keeps it for the getter. */
export function kotlinAccessorNames(property: string): { getter: string; setter: string } {
  const isPrefixed = /^is[A-Z0-9_]/.test(property);
  return {
    getter: isPrefixed ? property : `get${capitalize(property)}`,
    setter: isPrefixed ? `set${property.slice(2)}` : `set${capitalize(property)}`,
  };
}

/**
 * Every JVM-facing member of a Kotlin file. `private` declarations (not reachable from another
 * class), `internal` declarations (their JVM name is mangled), and `@JvmSynthetic` declarations
 * (hidden from Java) are not in the view. Local declarations never are.
 */
export function kotlinJvmMembers(content: string): KotlinJvmMember[] {
  const out: KotlinJvmMember[] = [];
  for (const declaration of scanKotlinDeclarations(content)) {
    if (declaration.kind !== 'function' && declaration.kind !== 'property') continue;
    if (declaration.visibility === 'private' || declaration.visibility === 'internal') continue;
    if (declaration.annotations.includes('JvmSynthetic')) continue;
    const jvmStatic = declaration.annotations.includes('JvmStatic');
    const base: KotlinJvmAccess = !declaration.owner ? 'facade'
      : declaration.ownerKind === 'object' ? 'instance'
        : declaration.ownerKind === 'companion' ? 'companion'
          : 'member';
    const accesses: KotlinJvmAccess[] = [base];
    const add = (jvmName: string, extra: Partial<KotlinJvmMember> = {}, access = accesses): void => {
      for (const one of access) out.push({ jvmName, access: one, ...(declaration.owner ? { owner: declaration.owner } : {}), declaration, ...extra });
    };
    if (declaration.kind === 'function') {
      if (jvmStatic && (base === 'instance' || base === 'companion')) accesses.push('static');
      add(annotationArgument(content, declaration, 'JvmName') ?? declaration.name);
      continue;
    }
    // A `const` or `@JvmField` property is a field, read directly; there is no accessor to call.
    if (declaration.modifiers.includes('const') || declaration.annotations.includes('JvmField')) continue;
    if (jvmStatic && (base === 'instance' || base === 'companion')) accesses.push('static');
    const names = kotlinAccessorNames(declaration.name);
    add(names.getter, { accessor: 'getter' });
    if (/^\s*(?:@\S+\s+|[a-z]+\s+)*var\b/.test(content.slice(declaration.offset, declaration.offset + 4))) add(names.setter, { accessor: 'setter' });
  }
  return out;
}
