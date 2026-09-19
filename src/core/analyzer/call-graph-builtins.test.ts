import { describe, it, expect } from 'vitest';
import { isIgnoredCallee, isIgnoredElixirCall } from './call-graph-builtins.js';

describe('isIgnoredElixirCall (issue #507)', () => {
  it('ignores special forms at any argument count', () => {
    for (const name of ['if', 'case', 'with', 'for', 'unless', 'receive']) {
      expect(isIgnoredElixirCall(name, 1)).toBe(true);
      expect(isIgnoredElixirCall(name, 3)).toBe(true);
    }
  });

  it("ignores Kernel functions only at Kernel's arities", () => {
    expect(isIgnoredElixirCall('send', 2)).toBe(true);
    expect(isIgnoredElixirCall('send', 3)).toBe(false);
    expect(isIgnoredElixirCall('to_string', 1)).toBe(true);
    expect(isIgnoredElixirCall('to_string', 2)).toBe(false);
    expect(isIgnoredElixirCall('self', 0)).toBe(true);
    expect(isIgnoredElixirCall('inspect', 2)).toBe(true);
    expect(isIgnoredElixirCall('floor', 1)).toBe(true);
  });

  it('keeps ordinary Elixir functions that other languages treat as builtins', () => {
    for (const name of ['map', 'find', 'new', 'parse', 'insert', 'delete', 'format', 'resolve', 'reject', 'input', 'at', 'size', 'clear', 'first', 'last', 'open']) {
      for (const arity of [0, 1, 2]) expect(isIgnoredElixirCall(name, arity)).toBe(false);
    }
  });
});

describe('isIgnoredCallee fallback union', () => {
  it('is unchanged for callers that pass no language', () => {
    expect(isIgnoredCallee('map')).toBe(true);
    expect(isIgnoredCallee('find')).toBe(true);
    expect(isIgnoredCallee('myFunction')).toBe(false);
  });

  it('does not gain Elixir-only names', () => {
    // Remote Elixir calls and Dart still use the union; `Mod.reraise()` must survive.
    for (const name of ['reraise', 'send', 'self', 'inspect', 'length', 'is_map', 'unless', 'receive']) {
      expect(isIgnoredCallee(name)).toBe(false);
    }
  });
});

describe('isIgnoredCallee — Dart', () => {
  it('ignores dart:core top-level builtins only', () => {
    expect(isIgnoredCallee('print', 'Dart')).toBe(true);
    expect(isIgnoredCallee('identical', 'Dart')).toBe(true);
    for (const name of ['map', 'find', 'insert', 'remove', 'contains', 'join', 'parse', 'format']) {
      expect(isIgnoredCallee(name, 'Dart')).toBe(false);
    }
  });
});
