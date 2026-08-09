const RANK = { current: 0, unassessable: 1, stale: 2 };

export function freshnessFromResponse(response) {
  const status = response.headers.get('X-OpenLore-Analysis-Freshness');
  if (!(status in RANK)) return null;
  const changed = response.headers.get('X-OpenLore-Files-Changed-Since');
  return {
    status,
    generatedAt: response.headers.get('X-OpenLore-Generated-At'),
    analyzedCommit: response.headers.get('X-OpenLore-Analyzed-Commit'),
    currentCommit: response.headers.get('X-OpenLore-Current-Commit'),
    filesChangedSince: changed === null ? null : Number(changed),
  };
}

/** Keep the least trustworthy freshness observed across rendered artifacts. */
export function mergeFreshness(current, next) {
  if (!next) return current;
  if (!current || RANK[next.status] > RANK[current.status]) return next;
  return current;
}
