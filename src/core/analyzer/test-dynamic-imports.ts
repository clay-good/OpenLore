/**
 * Names a test file takes from a relative module through a dynamic `import()`: the forms the static
 * import scan in `call-graph.ts` cannot see, so `select_tests` missed every test that loads its
 * module after setting up mocks or the environment.
 *
 * - `const { a, b: c } = await import('./x.js')` → a, b
 * - `(await import('./x.js')).a` and `typeof import('./x.js').a` → a
 * - `const mod = await import('./x.js')`, then `mod.a` → a
 *
 * Only relative specifiers count, as for static imports. Text-based and linear: each pattern has a
 * bounded, non-overlapping shape.
 */

const SPEC = String.raw`['"](\.{1,2}\/[^'"\n]+)['"]`;
const DESTRUCTURED = new RegExp(String.raw`\b(?:const|let|var)\s*\{([^{}]*)\}\s*=\s*await\s+import\(\s*${SPEC}\s*\)`, 'g');
const MEMBER = new RegExp(String.raw`\bimport\(\s*${SPEC}\s*\)\s*\)?\s*\.\s*([A-Za-z_$][\w$]*)`, 'g');
const NAMESPACE = new RegExp(String.raw`\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*await\s+import\(\s*${SPEC}\s*\)\s*;?`, 'g');

export function dynamicImportNames(content: string): Array<{ name: string; specifier: string }> {
  const out: Array<{ name: string; specifier: string }> = [];
  for (const m of content.matchAll(DESTRUCTURED)) {
    for (const part of m[1].split(',')) {
      // `{ a: b }` takes `a` from the module; a rest element (`...rest`) names nothing.
      const name = part.trim().match(/^([A-Za-z_$][\w$]*)/)?.[1];
      if (name) out.push({ name, specifier: m[2] });
    }
  }
  for (const m of content.matchAll(MEMBER)) out.push({ name: m[2], specifier: m[1] });
  for (const m of content.matchAll(NAMESPACE)) {
    const ns = m[1].replace(/\$/g, '\\$');
    for (const use of content.matchAll(new RegExp(String.raw`(?<![\w$.])${ns}\s*\.\s*([A-Za-z_$][\w$]*)`, 'g'))) {
      out.push({ name: use[1], specifier: m[2] });
    }
  }
  return out;
}
