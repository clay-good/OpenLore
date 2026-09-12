/**
 * Structural guard: every outbound `fetch(` on a credential- or repository-content-
 * carrying path refuses redirects.
 *
 * Per the fetch spec a cross-origin redirect strips only `Authorization`, `Cookie` and
 * `Proxy-Authorization` — `x-api-key`, `x-goog-api-key` and `x-openlore-token` survive it,
 * a key carried in the URL survives it, and a 307/308 replays the request BODY. That is
 * what makes `repo-config-trust`'s loopback exemption ("a loopback address cannot
 * exfiltrate") true only as long as nothing follows a redirect: a loopback listener a
 * hostile repo's dev script binds is otherwise a one-hop redirector to anywhere.
 *
 * Asserted by reading the source, not by exercising each call site: the point is that a
 * NEW fetch on these paths cannot be added without the option, which no runtime test of
 * the existing ones can enforce.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..', '..', '..');

const GUARDED_FILES = [
  'src/core/services/llm-service.ts',
  'src/core/services/chat-agent.ts',
  'src/core/services/serve-client.ts',
  'src/core/analyzer/embedding-service.ts',
  'src/cli/commands/view.ts',
  'src/cli/commands/doctor.ts',
  'src/pi/extension.ts',
];

/**
 * The options object of a `fetch(` call, located by brace matching from the call's own
 * parenthesis. Deliberately literal: it reads what a reviewer would read.
 */
function fetchCallSources(source: string): string[] {
  const calls: string[] = [];
  const pattern = /(?<![.\w])fetch\(/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    let depth = 1;
    let i = match.index + match[0].length;
    while (i < source.length && depth > 0) {
      const char = source[i];
      if (char === '(') depth++;
      else if (char === ')') depth--;
      i++;
    }
    calls.push(source.slice(match.index, i));
  }
  return calls;
}

describe('outbound fetch redirect discipline', () => {
  it.each(GUARDED_FILES)('every fetch() in %s sets redirect: \'error\'', (relativePath) => {
    const source = readFileSync(join(ROOT, relativePath), 'utf-8');
    const calls = fetchCallSources(source);
    expect(calls.length).toBeGreaterThan(0);
    const offenders = calls.filter(call => !/redirect:\s*'error'/.test(call));
    expect(offenders.map(call => call.slice(0, 120))).toEqual([]);
  });
});
