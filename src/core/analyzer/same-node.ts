/**
 * Whether two syntax-node objects are reads of the same node.
 *
 * Never compare tree-sitter nodes with `===`. The native binding caches node objects WEAKLY
 * (`tree-sitter/src/tree.cc`, `CacheNodeForTree`): after a garbage collection, or while a dead entry
 * waits for its finalizer, a second read of a node returns a NEW object. web-tree-sitter (Dart) makes
 * a new object on every read. So identity between two reads depends on GC timing. The node id is
 * stable for the life of the tree in both bindings.
 *
 * `===` is still correct against the very object a walk started from (`n !== root` in a walk that
 * began at `root`), because that compares one read with itself.
 */
export function sameNode(a: { id: number } | null | undefined, b: { id: number } | null | undefined): boolean {
  return !!a && !!b && a.id === b.id;
}
