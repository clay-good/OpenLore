import { describe, it, expect } from 'vitest';
import { isIgnoredCallee } from './call-graph-builtins.js';

describe('isIgnoredCallee — Elixir (issue #507)', () => {
  it('ignores special forms and Kernel builtins', () => {
    for (const name of ['if', 'case', 'with', 'for', 'raise', 'send', 'self', 'is_map', 'length', 'inspect', 'to_string']) {
      expect(isIgnoredCallee(name, 'Elixir')).toBe(true);
    }
  });

  it('keeps ordinary Elixir functions that other languages treat as builtins', () => {
    for (const name of ['map', 'find', 'new', 'parse', 'insert', 'delete', 'format', 'resolve', 'reject', 'input', 'at', 'size', 'clear', 'first', 'last', 'open']) {
      expect(isIgnoredCallee(name, 'Elixir')).toBe(false);
    }
  });

  it('leaves the cross-language fallback unchanged for callers that pass no language', () => {
    expect(isIgnoredCallee('map')).toBe(true);
    expect(isIgnoredCallee('find')).toBe(true);
    expect(isIgnoredCallee('myFunction')).toBe(false);
  });

  it('does not widen the fallback union with Elixir-only names', () => {
    // Remote Elixir calls and Dart still use the union; `Mod.reraise()` must survive.
    for (const name of ['reraise', 'send', 'self', 'inspect', 'length', 'is_map', 'unless']) {
      expect(isIgnoredCallee(name)).toBe(false);
    }
  });
});
