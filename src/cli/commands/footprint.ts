/**
 * `openlore footprint declare|release|list` — the peer footprint board from the CLI
 * (change: add-peer-footprint-board). The CLI face of `declare_footprint`.
 */

import { Command } from 'commander';
import { logger, configureLogger } from '../../utils/logger.js';
import { writeStdout } from '../output.js';
import { dispatchTool } from '../../core/services/tool-dispatch.js';
import { sanitizeForTerminal as safe } from '../../utils/misc.js';

interface PeerView { actorId: string; branch: string; worktree: string; title?: string; titleWithheld?: boolean; writes: string[]; creates: string[]; lastSeenAt: string; movedSinceDeclared?: string[]; hazard?: string; witnesses?: string[]; duplicateIntent?: string[] }

/** Plain-text rendering; every repository-derived value is sanitized for one terminal line. */
export function renderFootprint(r: Record<string, unknown>): string {
  const lines: string[] = [];
  const peer = (p: PeerView, lead: string) => {
    lines.push(safe(`${lead}${p.actorId}  ${p.branch || '(detached)'}  ${p.worktree}${p.title ? `  "${p.title}"` : p.titleWithheld ? '  (title withheld)' : ''}`));
    if (p.hazard) lines.push(safe(`    ${p.hazard}${p.witnesses?.length ? ` on ${p.witnesses.slice(0, 5).join(', ')}` : ''}${p.duplicateIntent?.length ? `; both create ${p.duplicateIntent.join(', ')}` : ''}`));
    if (p.movedSinceDeclared?.length) lines.push(safe(`    moved since declared: ${p.movedSinceDeclared.join(', ')}`));
  };
  if (r.action === 'release') {
    lines.push(safe(r.released ? `Released ${String(r.actorId)}.` : `No live entry for ${String(r.actorId)}.`));
  } else if (r.action === 'list') {
    const live = (r.live as PeerView[]) ?? [];
    lines.push(live.length ? `${live.length} live footprint(s):` : 'No live footprints on the board.');
    for (const p of live) peer(p, '  ');
  } else {
    const e = r.entry as { actorId: string; writes: string[]; reads: string[]; creates: string[] };
    lines.push(safe(`Declared ${e.actorId}: ${e.writes.length} write(s), ${e.reads.length} read(s)${e.creates.length ? `, creates ${e.creates.join(', ')}` : ''}.`));
    const conflicts = (r.conflicts as PeerView[]) ?? [];
    lines.push(conflicts.length ? `Hazards with ${conflicts.length} of ${String(r.livePeers)} live peer(s):` : `No hazard with ${String(r.livePeers)} live peer(s).`);
    for (const p of conflicts) peer(p, '  ⚠ ');
  }
  const ended = (r.ended as Array<{ actorId: string; reason: string }>) ?? [];
  for (const e of ended) lines.push(safe(`  ended: ${e.actorId} (${e.reason})`));
  for (const b of (r.boundaries as string[]) ?? []) lines.push(safe(`Boundary: ${b}`));
  return lines.join('\n');
}

async function run(args: Record<string, unknown>, json: boolean | undefined): Promise<number> {
  const cwd = process.cwd();
  configureLogger({ quiet: true });
  let result: unknown;
  try {
    result = await dispatchTool('declare_footprint', { directory: cwd, ...args }, cwd);
  } catch (err) {
    result = { error: err instanceof Error ? err.message : String(err) };
  } finally {
    configureLogger({ quiet: false });
  }
  if (result && typeof result === 'object' && 'error' in result) {
    const error = (result as { error: string }).error;
    if (json) await writeStdout(JSON.stringify({ status: 'unavailable', error }, null, 2) + '\n');
    else logger.warning(`footprint: ${safe(error)}`);
    return 1;
  }
  await writeStdout((json ? JSON.stringify(result, null, 2) : renderFootprint(result as Record<string, unknown>)) + '\n');
  return 0;
}

const list = (v: string) => v.split(',').map(s => s.trim()).filter(Boolean);

export const footprintCommand = new Command('footprint')
  .description('Share this agent\'s intended write-set and read-set with the other worktrees of this clone, and see the hazards with live peers (declare | release | list). Advisory; nothing is locked.');

footprintCommand.command('declare')
  .description('Declare (or refresh) this agent\'s footprint and print the hazards with live peers')
  .option('--write <symbols>', 'Comma-separated symbols or files you will write (new names are intended creations)', list)
  .option('--read <symbols>', 'Comma-separated symbols or files your work depends on', list)
  .option('--title <text>', 'Short task title (120 characters)')
  .option('--actor <id>', 'Stable agent id (default <branch>@<worktree folder>)')
  .option('--append', 'Your writes only add registry entries', false)
  .option('--json', 'Emit JSON', false)
  .action(async (o: { write?: string[]; read?: string[]; title?: string; actor?: string; append?: boolean; json?: boolean }) => {
    process.exit(await run({ action: 'declare', writeSet: o.write, readSet: o.read, title: o.title, actorId: o.actor, ...(o.append ? { writeMode: 'append' } : {}) }, o.json));
  });

footprintCommand.command('release')
  .description('Remove this agent\'s footprint from the board')
  .option('--actor <id>', 'Stable agent id (default <branch>@<worktree folder>)')
  .option('--json', 'Emit JSON', false)
  .action(async (o: { actor?: string; json?: boolean }) => {
    process.exit(await run({ action: 'release', actorId: o.actor }, o.json));
  });

footprintCommand.command('list')
  .description('List the live footprints on this clone\'s board')
  .option('--json', 'Emit JSON', false)
  .action(async (o: { json?: boolean }) => {
    process.exit(await run({ action: 'list' }, o.json));
  });
