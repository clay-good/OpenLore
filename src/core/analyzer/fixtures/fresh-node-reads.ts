/**
 * Test support: wrap a syntax node so EVERY read (a property, `.parent`, `namedChildren`,
 * `childForFieldName(...)`) returns a new object, as the native binding does after a garbage
 * collection. An extractor whose output changes under this wrapper depends on node object identity
 * (see `../same-node.ts`).
 */
export function freshOnEveryRead<T extends object>(node: T): T {
  const wrap = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(wrap);
    return v && typeof v === 'object' && 'startIndex' in v && 'type' in v ? freshOnEveryRead(v as object) : v;
  };
  return new Proxy(node, {
    get(target, prop) {
      const v = Reflect.get(target, prop, target);
      if (typeof v === 'function') return (...args: unknown[]) => wrap((v as (...a: unknown[]) => unknown).apply(target, args));
      return wrap(v);
    },
  });
}
