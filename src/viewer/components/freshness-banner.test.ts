import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { FreshnessBanner } from './FreshnessBanner.jsx';

describe('FreshnessBanner', () => {
  it('renders a dismissible warning for stale analysis', () => {
    const html = renderToStaticMarkup(createElement(FreshnessBanner, { freshness: {
      status: 'stale', analyzedCommit: 'abcdef1234567890', filesChangedSince: 2,
    } }));
    expect(html).toContain('STALE ANALYSIS');
    expect(html).toContain('DISMISS');
    expect(html).toContain('2 source files changed');
  });

  it('renders nothing for current analysis', () => {
    expect(renderToStaticMarkup(createElement(FreshnessBanner, {
      freshness: { status: 'current' },
    }))).toBe('');
  });
});
