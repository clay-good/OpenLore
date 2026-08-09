import { useState } from 'react';

export function FreshnessBanner({ freshness }) {
  const [dismissed, setDismissed] = useState(false);
  if (dismissed || freshness?.status !== 'stale') return null;

  const changed = freshness.filesChangedSince;
  return (
    <div
      role="status"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '7px 18px',
        color: 'var(--ac-warn, #f6c177)',
        background: 'var(--bg-raised)',
        borderBottom: '1px solid var(--ac-warn, #f6c177)',
        fontSize: 9,
        flexShrink: 0,
      }}
    >
      <strong>STALE ANALYSIS</strong>
      <span>
        Built at {freshness.analyzedCommit?.slice(0, 12) ?? 'an unknown commit'};
        {' '}{changed ?? 'some'} source file{changed === 1 ? '' : 's'} changed since.
        {' '}Run <code>openlore analyze</code> before relying on this graph.
      </span>
      <button
        type="button"
        aria-label="Dismiss stale analysis warning"
        onClick={() => setDismissed(true)}
        style={{
          marginLeft: 'auto',
          border: 0,
          background: 'transparent',
          color: 'inherit',
          cursor: 'pointer',
          fontFamily: 'inherit',
        }}
      >
        DISMISS
      </button>
    </div>
  );
}
