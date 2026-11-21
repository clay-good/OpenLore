import { describe, expect, it } from 'vitest';
import { isStorySourceChange } from './refresh-stories.js';

describe('isStorySourceChange', () => {
  it('skips files in the configured spec root as well as the default one', () => {
    expect(isStorySourceChange('specs-root/specs/api/schema.ts', 'specs-root')).toBe(false);
    expect(isStorySourceChange('openspec/specs/api/schema.ts', 'specs-root')).toBe(false);
    expect(isStorySourceChange('src/api/schema.ts', 'specs-root')).toBe(true);
  });

  it('a spec root of "." skips only its corpus folders, not all code', () => {
    expect(isStorySourceChange('changes/x/helper.ts', '.')).toBe(false);
    expect(isStorySourceChange('src/index.ts', '.')).toBe(true);
  });
});
