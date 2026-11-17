import { describe, it, expect } from 'vitest';
import { hideConsoleWindow } from './console-window.js';

describe('hideConsoleWindow', () => {
  it('hides when no standard stream is a terminal (console-less MCP/Pi daemon, hook, CI)', () => {
    expect(hideConsoleWindow([{ isTTY: false }, {}, { isTTY: undefined }])).toBe(true);
  });

  it('does not hide when any stream is a terminal, so the child keeps the terminal Ctrl-C', () => {
    expect(hideConsoleWindow([{}, { isTTY: true }, {}])).toBe(false);
  });
});
