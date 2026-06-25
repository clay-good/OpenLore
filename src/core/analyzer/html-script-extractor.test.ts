/**
 * HTML inline-script extractor (decision 5b38bad2).
 *
 * The offset-preserving blank must keep the output the SAME length as the input,
 * preserve newlines (so line numbers map to the HTML file), keep qualifying JS
 * bodies verbatim at their exact offsets, and blank out markup and non-JS /
 * external scripts. An integration test confirms the blanked content drives the
 * JS call-graph extractor to HTML-accurate nodes.
 */
import { describe, it, expect } from 'vitest';
import { extractHtmlScripts, isInlineJsScript } from './html-script-extractor.js';

describe('isInlineJsScript', () => {
  it('keeps no-type, text/javascript, module; rejects json/importmap/external', () => {
    expect(isInlineJsScript('')).toBe(true);
    expect(isInlineJsScript(' type="text/javascript"')).toBe(true);
    expect(isInlineJsScript(' type="module"')).toBe(true);
    expect(isInlineJsScript(' type="application/json"')).toBe(false);
    expect(isInlineJsScript(' type="importmap"')).toBe(false);
    expect(isInlineJsScript(' src="app.js"')).toBe(false);
    expect(isInlineJsScript(' src="app.js" type="text/javascript"')).toBe(false);
  });

  it('does not let data-type / data-src false-match the type/src filters', () => {
    // data-type must not be read as the script type.
    expect(isInlineJsScript(' data-type="application/json"')).toBe(true);
    // data-src is not an external-script signal.
    expect(isInlineJsScript(' data-src="x"')).toBe(true);
  });

  it('tolerates a charset suffix on the type', () => {
    expect(isInlineJsScript(' type="text/javascript; charset=utf-8"')).toBe(true);
  });
});

describe('extractHtmlScripts', () => {
  it('returns null when there is no inline JS', () => {
    expect(extractHtmlScripts('<html><body><p>hi</p></body></html>')).toBeNull();
    expect(extractHtmlScripts('<script src="app.js"></script>')).toBeNull();
    expect(extractHtmlScripts('<script type="application/json">{"a":1}</script>')).toBeNull();
  });

  it('preserves length and newlines; keeps the body; blanks the markup', () => {
    const html = [
      '<html>',
      '<body>',
      '<script>',
      'function foo() { return 1; }',
      '</script>',
      '</body>',
      '</html>',
    ].join('\n');
    const out = extractHtmlScripts(html)!;
    expect(out).not.toBeNull();
    // Same length, identical newline positions.
    expect(out.length).toBe(html.length);
    expect(out.split('\n').length).toBe(html.split('\n').length);
    // The JS body survives verbatim, at the same line.
    expect(out).toContain('function foo() { return 1; }');
    // Markup is blanked — the tags are gone, replaced by spaces.
    expect(out).not.toContain('<body>');
    expect(out).not.toContain('<html>');
    // The body sits on the same line index as in the source.
    const srcLine = html.split('\n').findIndex((l) => l.includes('function foo'));
    const outLine = out.split('\n').findIndex((l) => l.includes('function foo'));
    expect(outLine).toBe(srcLine);
  });

  it('keeps multiple script bodies and blanks a json block between them', () => {
    const html =
      '<script>function a(){}</script>' +
      '<script type="application/json">{"x":1}</script>' +
      '<script type="module">function b(){}</script>';
    const out = extractHtmlScripts(html)!;
    expect(out.length).toBe(html.length);
    expect(out).toContain('function a(){}');
    expect(out).toContain('function b(){}');
    expect(out).not.toContain('{"x":1}');
  });

  it('handles a whitespace-tolerant close tag without corrupting offsets', () => {
    const html = '<script>function a(){}</script >after';
    const out = extractHtmlScripts(html)!;
    expect(out.length).toBe(html.length);
    expect(out).toContain('function a(){}');
    expect(out).not.toContain('after'); // markup after the script is blanked
  });

  it('does not hang or index an unterminated <script> (no quadratic scan)', () => {
    // Many open tags with no close tag — the old combined regex was O(N²) here.
    // 100k tags makes a quadratic scan catastrophic (tens of seconds) while the
    // linear scan stays in the millisecond range, so the time bound discriminates
    // linear-vs-quadratic with wide headroom — robust against CI-load jitter (a
    // tight ~1s bound flaked on shared runners even though the scan is linear).
    const html = '<script>'.repeat(100_000) + 'function never(){}';
    const t0 = Date.now();
    const out = extractHtmlScripts(html);
    expect(Date.now() - t0).toBeLessThan(5000);
    // No close tag anywhere → nothing is indexed.
    expect(out).toBeNull();
  });

  it('keeps a real script even when an earlier one is unterminated', () => {
    const html = '<script>broken' + '\n' + '<script>function ok(){}</script>';
    const out = extractHtmlScripts(html)!;
    expect(out.length).toBe(html.length);
    expect(out).toContain('function ok(){}');
  });
});

describe('inline scripts → call graph', () => {
  it('produces HTML-anchored nodes and a call edge with correct line numbers', async () => {
    const { CallGraphBuilder } = await import('./call-graph.js');
    const html = [
      '<!DOCTYPE html>',         // line 1
      '<html><body>',            // line 2
      '<script>',                // line 3
      '  function foo() {',      // line 4
      '    bar();',              // line 5
      '  }',                     // line 6
      '  function bar() {}',     // line 7
      '</script>',               // line 8
      '</body></html>',          // line 9
    ].join('\n');
    const blanked = extractHtmlScripts(html)!;

    const builder = new CallGraphBuilder();
    const result = await builder.build([
      { path: 'public/index.html', content: blanked, language: 'JavaScript' },
    ]);

    const nodes = [...result.nodes.values()];
    const foo = nodes.find((n) => n.name === 'foo');
    const bar = nodes.find((n) => n.name === 'bar');
    expect(foo).toBeDefined();
    expect(bar).toBeDefined();
    expect(foo!.filePath).toBe('public/index.html');
    // foo is defined on line 4, bar on line 7 — offsets mapped through the HTML.
    expect(foo!.startLine).toBe(4);
    expect(bar!.startLine).toBe(7);
    // foo → bar edge exists.
    expect(result.edges.some((e) => e.callerId === foo!.id && e.calleeId === bar!.id)).toBe(true);
  });
});
