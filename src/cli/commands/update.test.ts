import { describe, it, expect } from 'vitest';
import { detectInstallMethod, upgradeCommandFor } from './update.js';

describe('detectInstallMethod', () => {
  it('detects Homebrew installs', () => {
    expect(detectInstallMethod('/opt/homebrew/Cellar/openlore/2.1.3/libexec/dist/cli/index.js')).toBe('homebrew');
    expect(detectInstallMethod('/usr/local/Cellar/openlore/2.1.3/dist/cli/update.js')).toBe('homebrew');
    expect(detectInstallMethod('/home/linuxbrew/.linuxbrew/Cellar/openlore/2.1.3/x.js')).toBe('homebrew');
  });

  it('detects npx (transient) installs', () => {
    expect(detectInstallMethod('/Users/x/.npm/_npx/abc123/node_modules/openlore/dist/cli/update.js')).toBe('npx');
  });

  it('detects global npm installs', () => {
    expect(detectInstallMethod('/usr/local/lib/node_modules/openlore/dist/cli/update.js')).toBe('npm-global');
    expect(detectInstallMethod('/Users/x/.nvm/versions/node/v22.5.0/lib/node_modules/openlore/dist/x.js')).toBe('npm-global');
  });

  it('returns unknown for unrecognized paths', () => {
    expect(detectInstallMethod('/some/random/checkout/dist/cli/update.js')).toBe('unknown');
  });

  it('is case-insensitive', () => {
    expect(detectInstallMethod('/opt/HomeBrew/Cellar/openlore/x.js')).toBe('homebrew');
  });
});

describe('upgradeCommandFor', () => {
  it('maps each method to the correct upgrade command', () => {
    expect(upgradeCommandFor('homebrew')).toEqual({ cmd: 'brew', args: ['upgrade', 'openlore'] });
    expect(upgradeCommandFor('npm-global')).toEqual({ cmd: 'npm', args: ['install', '-g', 'openlore@latest'] });
    expect(upgradeCommandFor('npx')).toBeNull();
    expect(upgradeCommandFor('unknown')).toBeNull();
  });
});
