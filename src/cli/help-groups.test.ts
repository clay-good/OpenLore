/**
 * Tests for job-grouped `openlore --help` (change: refine-happy-path-and-defaults /
 * CommandSurfaceGroupedByJob). Verifies the Commands section is grouped by job, that
 * every command stays visible (uncategorized commands fall to "Other", never hidden),
 * and that the grouping data is internally consistent.
 */

import { describe, it, expect } from 'vitest';
import { Command } from 'commander';
import { COMMAND_GROUPS, groupForCommand, applyJobGroupedHelp } from './help-groups.js';

function renderHelp(commandNames: string[]): string {
  const program = new Command('openlore');
  for (const name of commandNames) {
    program.command(name).description(`does ${name}`);
  }
  applyJobGroupedHelp(program);
  return program.helpInformation();
}

describe('help-groups', () => {
  it('has no duplicate command name across groups', () => {
    const all = COMMAND_GROUPS.flatMap((g) => g.commands);
    expect(new Set(all).size).toBe(all.length);
  });

  it('maps known commands to their job group and unknowns to Other', () => {
    expect(groupForCommand('install')).toBe('Set up & run');
    expect(groupForCommand('orient')).toBe('Navigate the code');
    expect(groupForCommand('enforce')).toBe('Govern a change');
    expect(groupForCommand('panic-check')).toBe('Advanced / experimental');
    expect(groupForCommand('federation')).toBe('Multi-repo & sharing');
    expect(groupForCommand('features')).toBe('Set up & run');
    expect(groupForCommand('totally-new-command')).toBe('Other');
  });

  it('renders the Commands section grouped by job, in declared order', () => {
    const help = renderHelp(['install', 'orient', 'enforce', 'panic-check']);
    expect(help).toContain('Set up & run');
    expect(help).toContain('Navigate the code');
    expect(help).toContain('Govern a change');
    expect(help).toContain('Advanced / experimental');
    // Order: set-up group header precedes the govern group header.
    expect(help.indexOf('Set up & run')).toBeLessThan(help.indexOf('Govern a change'));
    // A command renders under its group.
    expect(help).toMatch(/Navigate the code[\s\S]*orient/);
  });

  it('orders groups by job regardless of the order commands were registered', () => {
    // Commander emits help groups in subcommand-registration order; the ordering
    // override must impose the declared job order instead. Register backwards to prove it.
    const help = renderHelp(['panic-check', 'enforce', 'orient', 'install']);
    const order = ['Set up & run:', 'Navigate the code:', 'Govern a change:', 'Advanced / experimental:'];
    const positions = order.map((h) => help.indexOf(h));
    expect(positions.every((p) => p !== -1)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it('orders commands WITHIN a group by declared order, not registration order', () => {
    // `install` is the front door: declared first in "Set up & run" but registered late
    // in index.ts. Registration order must not demote it.
    const help = renderHelp(['doctor', 'analyze', 'install', 'init']);
    expect(help.indexOf('install')).toBeLessThan(help.indexOf('init'));
    expect(help.indexOf('init')).toBeLessThan(help.indexOf('analyze'));
    expect(help.indexOf('analyze')).toBeLessThan(help.indexOf('doctor'));
  });

  it('never hides a command: an uncategorized command falls under Other', () => {
    const help = renderHelp(['install', 'brand-new-cmd']);
    expect(help).toContain('brand-new-cmd');
    expect(help).toMatch(/Other:[\s\S]*brand-new-cmd/);
  });

  it('puts the built-in help command in Other rather than its own stray section', () => {
    // Commander creates `help [command]` lazily, so it never appears in program.commands
    // and is only grouped via the default command group.
    const help = renderHelp(['install']);
    expect(help).toMatch(/Other:[\s\S]*help \[command\]/);
    // No leftover ungrouped "Commands:" section.
    expect(help).not.toMatch(/^Commands:$/m);
  });

  it('places every group title last-to-first without dropping any command', () => {
    const names = COMMAND_GROUPS.flatMap((g) => g.commands);
    const help = renderHelp(names);
    for (const name of names) {
      expect(help).toContain(name);
    }
  });

  it('omits a group header when no command in it is present', () => {
    const help = renderHelp(['install']); // only a Set-up command
    expect(help).toContain('Set up & run');
    expect(help).not.toContain('Govern a change');
    expect(help).not.toContain('Advanced / experimental');
  });

  it('leaves the usage and options sections to Commander, ungrouped and unreordered', () => {
    const program = new Command('openlore');
    program.option('-q, --quiet', 'minimal output');
    program.command('install').description('set up');
    applyJobGroupedHelp(program);
    const help = program.helpInformation();
    expect(help).toMatch(/Usage: openlore/);
    expect(help).toContain('Options:');
    expect(help).toContain('--quiet');
  });
});
