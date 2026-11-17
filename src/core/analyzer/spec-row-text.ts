/**
 * A spec row's text without the `[spec:<domain>] <title>` line the index adds: the part copied from
 * the spec file. Empty when the row has no body.
 */
export function specRowProse(domain: string, title: string, text: string): string {
  const header = `[spec:${domain}] ${title}`;
  return text.startsWith(`${header}\n`) ? text.slice(header.length + 1) : '';
}
