/**
 * Decision autopilot mode resolver and trail readers
 * (change: default-decision-autopilot-with-visible-trace).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  DECISIONS_HOOK_MARKER,
  collectGovernanceStatus,
  countUnreviewedDecisions,
  resolveAutopilotMode,
  takeAutoAcceptsSinceLastSession,
} from './autopilot.js';
import { appendLedgerEntries, type LedgerEntry } from './ledger.js';

// A config with no `governance` block, as auto-init writes it.
const CONFIG: { governance?: { autopilot?: boolean } } = {};

function entry(id: string, to: LedgerEntry['to'], at: string): LedgerEntry {
  return { id, title: `Decision ${id}`, from: null, to, actor: 'agent', at };
}

describe('resolveAutopilotMode', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'openlore-autopilot-mode-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('is on when governance.autopilot is absent and no gate is installed', async () => {
    const mode = await resolveAutopilotMode(dir, CONFIG);
    expect(mode).toMatchObject({ autopilot: true, source: 'default' });
    expect(mode.reason).toBe('auto-initialized; set governance.autopilot: false to require review');
  });

  it('is on for true and off for false, whatever the gate', async () => {
    expect((await resolveAutopilotMode(dir, { governance: { autopilot: true } }, { gateRunning: true })).autopilot).toBe(true);
    expect((await resolveAutopilotMode(dir, { governance: { autopilot: false } })).autopilot).toBe(false);
  });

  it('stays blocking when absent and a blocking decisions gate is installed', async () => {
    execFileSync('git', ['init', '-q'], { cwd: dir });
    await mkdir(join(dir, '.git', 'hooks'), { recursive: true });
    await writeFile(join(dir, '.git', 'hooks', 'pre-commit'), `#!/bin/sh\n${DECISIONS_HOOK_MARKER}\nopenlore decisions --gate\n`);
    expect(await resolveAutopilotMode(dir, CONFIG)).toMatchObject({ autopilot: false, source: 'blocking-gate' });
  });

  it('stays blocking when absent and the gate itself is running', async () => {
    expect(await resolveAutopilotMode(dir, CONFIG, { gateRunning: true })).toMatchObject({ autopilot: false, source: 'blocking-gate' });
  });

  it('is off where OpenLore was never set up (no config)', async () => {
    expect(await resolveAutopilotMode(dir, null)).toMatchObject({ autopilot: false, source: 'no-config' });
  });

  it("a linked worktree follows the main checkout's choice when its own config has none", async () => {
    // The gate lives in the hooks every worktree shares; the config is per checkout.
    const main = join(dir, 'main');
    const tree = join(dir, 'tree');
    await mkdir(main);
    const git = (...args: string[]) => execFileSync('git', args, { cwd: main, stdio: 'ignore' });
    git('init', '-q');
    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init');
    await writeFile(join(main, '.git', 'hooks', 'pre-commit'), `#!/bin/sh\n${DECISIONS_HOOK_MARKER}\nopenlore decisions --gate\n`);
    git('worktree', 'add', '-q', tree);
    await mkdir(join(main, '.openlore'));
    await writeFile(join(main, '.openlore', 'config.json'), JSON.stringify({ governance: { autopilot: true } }));
    expect(await resolveAutopilotMode(tree, CONFIG, { gateRunning: true })).toMatchObject({ autopilot: true, source: 'main-checkout' });
    await writeFile(join(main, '.openlore', 'config.json'), JSON.stringify({ governance: { autopilot: false } }));
    expect(await resolveAutopilotMode(tree, CONFIG)).toMatchObject({ autopilot: false, source: 'main-checkout' });
    // The worktree's own choice still wins.
    expect(await resolveAutopilotMode(tree, { governance: { autopilot: true } })).toMatchObject({ autopilot: true, source: 'config-on' });
    // The main checkout itself is not "inherited" from anywhere.
    expect((await resolveAutopilotMode(main, CONFIG)).source).toBe('blocking-gate');
  });
});

describe('governance trail readers', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'openlore-autopilot-trail-'));
    await mkdir(join(dir, '.openlore', 'decisions'), { recursive: true });
    await writeFile(join(dir, '.openlore', 'decisions', 'pending.json'), JSON.stringify({
      decisions: [
        { id: 'a', status: 'auto-approved' },
        { id: 'b', status: 'auto-approved', humanReviewedAt: '2026-10-01T00:00:00Z' },
        { id: 'c', status: 'draft' },
      ],
    }));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('counts only unreviewed auto-accepted decisions, and 0 without a store', async () => {
    expect(await countUnreviewedDecisions(dir)).toBe(1);
    expect(await countUnreviewedDecisions(join(dir, 'nowhere'))).toBe(0);
  });

  it('reports mode, counts, the newest three ledger entries and the review command', async () => {
    await appendLedgerEntries(dir, [
      entry('a', 'auto-approved', '2026-10-01T00:00:00Z'),
      entry('b', 'auto-approved', '2026-10-02T00:00:00Z'),
      entry('c', 'draft', '2026-10-03T00:00:00Z'),
      entry('d', 'auto-approved', '2026-10-04T00:00:00Z'),
    ]);
    const status = await collectGovernanceStatus(dir, CONFIG);
    expect(status).toMatchObject({ autopilot: true, autoAccepted: 3, unreviewed: 1, review: 'openlore decisions review' });
    expect(status.recent.map((e) => e.id)).toEqual(['d', 'c', 'b']);
  });

  it('names auto-accepts since the previous session once, then advances the cursor', async () => {
    await appendLedgerEntries(dir, [
      entry('a', 'auto-approved', '2020-01-01T00:00:00Z'),
      entry('c', 'draft', '2020-01-01T00:00:00Z'),
    ]);
    expect((await takeAutoAcceptsSinceLastSession(dir)).map((e) => e.id)).toEqual(['a']);
    expect(await takeAutoAcceptsSinceLastSession(dir)).toEqual([]);
    const cursor = JSON.parse(await readFile(join(dir, '.openlore', 'runtime', 'decisions-session-cursor.json'), 'utf-8'));
    expect(Number.isNaN(Date.parse(cursor.at))).toBe(false);
  });
});
