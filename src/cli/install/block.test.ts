import { describe, it, expect } from 'vitest';
import {
  upsertBlock,
  extractBlock,
  isHandEdited,
  removeBlock,
  fingerprint,
  BLOCK_BEGIN,
  BLOCK_END,
} from './block.js';

const CONTENT = 'hello openlore';

describe('block', () => {
  it('creates a block in an empty file', () => {
    const { next, action } = upsertBlock('', CONTENT);
    expect(action).toBe('created');
    expect(next).toContain(BLOCK_BEGIN);
    expect(next).toContain(BLOCK_END);
    expect(next).toContain(CONTENT);
  });

  it('appends a block to existing content', () => {
    const existing = '# title\n\nsome text\n';
    const { next, action } = upsertBlock(existing, CONTENT);
    expect(action).toBe('created');
    expect(next.startsWith(existing)).toBe(true);
    expect(next).toContain(BLOCK_BEGIN);
  });

  it('is a no-op when content matches fingerprint', () => {
    const { next } = upsertBlock('', CONTENT);
    const second = upsertBlock(next, CONTENT);
    expect(second.action).toBe('noop');
    expect(second.next).toBe(next);
  });

  it('updates the block when content changes', () => {
    const first = upsertBlock('', CONTENT).next;
    const second = upsertBlock(first, 'new content');
    expect(second.action).toBe('updated');
    expect(second.next).toContain('new content');
    expect(second.next).not.toContain(CONTENT);
  });

  it('detects hand-edits inside the block', () => {
    const written = upsertBlock('', CONTENT).next;
    const tampered = written.replace(CONTENT, 'sneaky edit');
    const block = extractBlock(tampered);
    expect(block).not.toBeNull();
    expect(isHandEdited(block!)).toBe(true);
  });

  it('reports no hand-edit when content is untouched', () => {
    const written = upsertBlock('', CONTENT).next;
    const block = extractBlock(written);
    expect(block).not.toBeNull();
    expect(isHandEdited(block!)).toBe(false);
  });

  it('removeBlock restores file to a block-free state', () => {
    const existing = '# title\n\nbody\n';
    const withBlock = upsertBlock(existing, CONTENT).next;
    const after = removeBlock(withBlock);
    expect(after).not.toBeNull();
    expect(after).not.toContain(BLOCK_BEGIN);
    expect(after).toContain('# title');
    expect(after).toContain('body');
  });

  it('removeBlock yields empty string when file was OpenLore-only', () => {
    const written = upsertBlock('', CONTENT).next;
    const after = removeBlock(written);
    expect(after).toBe('');
  });

  it('fingerprint is deterministic', () => {
    expect(fingerprint('a')).toBe(fingerprint('a'));
    expect(fingerprint('a')).not.toBe(fingerprint('b'));
  });

  it('a CRLF checkout of an untouched block is not a hand edit (change: trim-standing-agent-instructions)', () => {
    const lf = upsertBlock('# project\n', 'line one\nline two').next;
    const crlf = lf.split('\n').join('\r\n');
    const block = extractBlock(crlf)!;
    expect(block.inner).toContain('\r\n');
    expect(isHandEdited(block)).toBe(false);
    // A real edit is still one.
    expect(isHandEdited(extractBlock(crlf.replace('line two', 'edited'))!)).toBe(true);
  });
});
