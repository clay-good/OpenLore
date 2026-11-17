import { describe, it, expect } from 'vitest';
import { previewCreate, previewDiff } from './diff.js';

describe('diff', () => {
  it('previewCreate shows every line prefixed with +', () => {
    const out = previewCreate('foo.md', 'line1\nline2');
    expect(out).toContain('(new file) foo.md');
    expect(out).toContain('+ line1');
    expect(out).toContain('+ line2');
  });

  it('previewCreate truncates very long files', () => {
    const content = Array.from({ length: 100 }, (_, i) => `line${i}`).join('\n');
    const out = previewCreate('big.md', content);
    expect(out).toContain('... (40 more lines)');
  });

  it('previewDiff trims common prefix and suffix', () => {
    const before = 'a\nb\nold\nc\nd';
    const after = 'a\nb\nnew\nc\nd';
    const out = previewDiff('x.md', before, after);
    expect(out).toContain('- old');
    expect(out).toContain('+ new');
    expect(out).not.toContain('- a');
    expect(out).not.toContain('+ d');
  });

  it('previewDiff anchors the hunk header at the right line', () => {
    const before = 'a\nb\nc\nd';
    const after = 'a\nb\nc\nADDED\nd';
    const out = previewDiff('x.md', before, after);
    expect(out).toContain('@ line 4');
    expect(out).toContain('+ ADDED');
  });
});

/**
 * `--dry-run` previews render the user's `~/.claude.json`, which holds an `signedInAccount` block
 * and per-MCP-server `env` blocks with API keys. Prefix/suffix trimming called everything between
 * the first and last changed line "the changed region", so one re-ordered key near the top plus a
 * changed fingerprint near the bottom printed ~11 KB of untouched private configuration — twice —
 * on a command that looks read-only (change: fix-install-never-blocks-by-default).
 */
describe('previewDiff does not print untouched configuration', () => {
  /** A config-shaped file: a managed region, a long private middle, a managed tail. */
  const config = (openlorePreset: string, fingerprint: string, reversed = false) => JSON.stringify({
    mcpServers: {
      openlore: reversed
        ? { args: ['index.js', 'mcp', '--preset', openlorePreset], command: 'node' }
        : { command: 'node', args: ['index.js', 'mcp', '--preset', openlorePreset] },
      other: { command: 'x', env: { API_KEY: 'INVENTEDSECRETVALUE0123456789' } },
    },
    uiNoticeCounters: Object.fromEntries(
      Array.from({ length: 60 }, (_, i) => [`notice_${i}`, i]),
    ),
    signedInAccount: { accountRef: 'INVENTED-PRIVATE-REF', emailAddress: 'invented-user.example' },
    _openlore: { managed: true, fingerprint },
  }, null, 2);

  it('prints a bounded window and omits keys far from the change', () => {
    const out = previewDiff('~/.claude.json', config('substrate', 'aaaa'), config('full', 'bbbb'));

    // Bounded: a changed-region dump was 255 lines for this shape.
    expect(out.split('\n').length).toBeLessThanOrEqual(70);
    // The change itself is shown.
    expect(out).toContain('- ');
    expect(out).toContain('+ ');
    expect(out).toContain('full');
    // Untouched private keys, which sit BETWEEN the two changed hunks, are not.
    expect(out).not.toContain('notice_');
    expect(out).not.toContain('INVENTED-PRIVATE-REF');
    expect(out).not.toContain('invented-user.example');
  });

  it('stays bounded when the change also shifts key order', () => {
    // A key-order shift inside `mcpServers.openlore` is what ballooned the region in the field:
    // every line of the object differs, so prefix/suffix trimming found no common anchor until
    // far past the untouched middle.
    const out = previewDiff(
      '~/.claude.json',
      config('substrate', 'aaaa', true),
      config('full', 'bbbb', false),
    );

    expect(out.split('\n').length).toBeLessThanOrEqual(70);
    expect(out).not.toContain('notice_');
    expect(out).not.toContain('INVENTED-PRIVATE-REF');
  });

  it('redacts a credential that genuinely sits inside a changed hunk', () => {
    // Rule 2: bounding is not enough on its own — a secret can be IN the hunk.
    const before = 'a\n"env": { "API_KEY": "INVENTEDOLDSECRET0123456789" }\nz';
    const after = 'a\n"env": { "API_KEY": "INVENTEDNEWSECRET0123456789" }\nz';
    const out = previewDiff('~/.claude.json', before, after);
    expect(out).not.toContain('OLD-SECRET-VALUE-HERE');
    expect(out).not.toContain('NEW-SECRET-VALUE-HERE');
  });

  it('previewCreate redacts too — a new file is rendered in full', () => {
    const out = previewCreate('.mcp.json', '{ "env": { "token": "INVENTEDCREATETOKEN0123456789" } }');
    expect(out).not.toContain('INVENTEDCREATETOKEN0123456789');
  });

  it('reports a region too large to diff precisely instead of dumping it', () => {
    const before = Array.from({ length: 900 }, (_, i) => `old-${i}`).join('\n');
    const after = Array.from({ length: 900 }, (_, i) => `new-${i}`).join('\n');
    const out = previewDiff('big.json', before, after);
    expect(out).toContain('too large');
    expect(out.split('\n').length).toBeLessThanOrEqual(70);
  });
});
