/**
 * Disclosed rendering caps for console reports.
 *
 * Several analyze reports are lists whose length is a property of the analyzed
 * repository, not of OpenLore: a strongly-connected component can hold every
 * function in a package, and a `.pb.go`-style accessor clone group can hold
 * hundreds of members. Joining those into one console line produced single
 * lines of tens of thousands of characters that no terminal can show and no
 * human can read.
 *
 * These helpers cap what is PRINTED and always disclose the exact number of
 * names withheld, in the house `… and N more <noun>s` style. The full lists stay
 * in the JSON artifacts (`refactor-priorities.json`, `duplicates.json`, …),
 * which every capped render names — so nothing becomes unreachable, and a
 * truncation is never quiet.
 */

/** Names shown from one cycle (strongly-connected component) chain. */
export const CYCLE_MEMBERS_SHOWN = 8;
/** Cycle lines shown before the rest are disclosed as a count. */
export const CYCLE_LINES_SHOWN = 10;
/** Members shown from one clone group. */
export const CLONE_MEMBERS_SHOWN = 6;
/** Names shown in a flat inventory line (detected domains, workspace shards). */
export const INVENTORY_ITEMS_SHOWN = 8;

/**
 * Join `items` with `separator`, keeping at most `shown` of them and appending
 * an exact `… and N more <noun>s` disclosure when any were withheld.
 *
 * `noun` is the singular form; it is pluralized with a trailing `s`.
 * Never silently truncates: with `items.length <= shown` the result is exactly
 * `items.join(separator)`.
 */
export function joinCapped(
  items: readonly string[],
  shown: number,
  separator: string,
  noun: string,
): string {
  const limit = Math.max(0, Math.trunc(shown));
  if (items.length <= limit) return items.join(separator);
  const omitted = items.length - limit;
  const head = items.slice(0, limit).join(separator);
  const disclosure = `… and ${omitted} more ${noun}${omitted === 1 ? '' : 's'}`;
  return limit === 0 ? disclosure : `${head}  ${disclosure}`;
}

/**
 * The `… and N more <noun>s` suffix for a list rendered on its own lines, or
 * `null` when every item was shown.
 */
export function omittedDisclosure(
  total: number,
  shown: number,
  noun: string,
): string | null {
  const omitted = total - Math.max(0, Math.trunc(shown));
  if (omitted <= 0) return null;
  return `… and ${omitted} more ${noun}${omitted === 1 ? '' : 's'}`;
}
