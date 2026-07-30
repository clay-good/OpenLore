/**
 * Job-grouped `openlore --help` (change: refine-happy-path-and-defaults /
 * CommandSurfaceGroupedByJob).
 *
 * OpenLore has ~49 top-level commands. Commander's default help lists them in one
 * flat block, so `install` and `orient` sit beside the experimental `panic-*`
 * suite and `gryph-watch` with no altitude marker — a new user can't tell the
 * front door from the basement. This module groups the Commands section of the
 * top-level help by JOB (set up · navigate · govern a change · inspect · multi-repo
 * · advanced/experimental), mirroring the capability families.
 *
 * It only changes PRESENTATION. Every command stays invocable, and any command not
 * yet categorized falls through to an "Other" group, so a newly-added command is
 * never hidden — it just shows ungrouped until it is placed.
 *
 * Grouping is delegated to Commander's own `.helpGroup()` support (added in
 * Commander 14): each subcommand is tagged with its job heading and Commander renders
 * the groups. We previously hand-reproduced Commander 12's `formatHelp` to do this,
 * which broke on upgrade when `Help.wrap()` was removed. Tagging instead of
 * reproducing means every other part of help rendering — wrapping, padding, styling,
 * usage, options — stays Commander's, so it cannot drift again.
 *
 * The one thing Commander does not decide for us is group ORDER: it emits groups in
 * the order subcommands were registered. `orderCommandGroups` reorders them into the
 * job order declared below.
 */

import { Help, type Command, type Option } from 'commander';

/** Job groups, in display order. Each lists the command names it contains. */
export const COMMAND_GROUPS: ReadonlyArray<{ title: string; commands: readonly string[] }> = [
  {
    title: 'Set up & run',
    commands: ['install', 'connect', 'init', 'analyze', 'embed', 'mcp', 'serve', 'doctor', 'features', 'setup', 'update', 'view'],
  },
  {
    title: 'Navigate the code',
    commands: ['orient', 'prove'],
  },
  {
    title: 'Govern a change',
    commands: [
      'blast-radius',
      'impact-certificate',
      'certify-public-surface',
      'enforce',
      'review',
      'preflight',
      'drift',
      'decisions',
      'coverage-gaps',
      'working-set',
      'briefing-since',
    ],
  },
  {
    title: 'Inspect & author specs',
    commands: ['audit', 'env-impact', 'error-propagation', 'find-clones', 'style-fingerprint', 'test', 'digest', 'generate', 'verify', 'run'],
  },
  {
    title: 'Multi-repo & sharing',
    commands: ['federation', 'spec-store', 'export', 'import', 'manifest', 'plugin-manifest'],
  },
  {
    title: 'Advanced / experimental',
    commands: ['panic-check', 'panic-level', 'panic-validate', 'panic-hotspots', 'panic-calibrate', 'panic-replay', 'gryph-watch', 'telemetry', 'refresh-stories'],
  },
];

/** The label for any command not placed in a group above (safety net — never hidden). */
const OTHER_GROUP_TITLE = 'Other';

/** Resolve which group a command name belongs to, or the Other group. */
export function groupForCommand(name: string): string {
  for (const g of COMMAND_GROUPS) {
    if (g.commands.includes(name)) return g.title;
  }
  return OTHER_GROUP_TITLE;
}

/**
 * Commander renders a group heading verbatim, so match its built-in section style
 * ("Commands:", "Options:") and give every job group a trailing colon.
 */
export function groupHeading(title: string): string {
  return `${title}:`;
}

/** Job headings in display order, with the catch-all last. */
const GROUP_ORDER: readonly string[] = [
  ...COMMAND_GROUPS.map((g) => groupHeading(g.title)),
  groupHeading(OTHER_GROUP_TITLE),
];

/** Heading → the order its commands are declared in, so members sort by intent too. */
const MEMBER_ORDER = new Map<string, readonly string[]>(
  COMMAND_GROUPS.map((g) => [groupHeading(g.title), g.commands])
);

/**
 * A Commander `groupItems` override that emits our job groups — and the commands
 * inside them — in declared order rather than in subcommand-registration order.
 *
 * Member order matters as much as group order: `install` is the front door and is
 * declared first in "Set up & run" for that reason, but it is registered late in
 * `index.ts`. A command not named in the group (the "Other" catch-all) keeps its
 * registration order, after any named ones.
 *
 * Headings we do not own (Commander's own "Options:", or any option group) keep their
 * original position and member order, so this only touches the Commands section.
 */
export function orderCommandGroups<T extends Command | Option>(
  this: Help,
  unsortedItems: T[],
  visibleItems: T[],
  getGroup: (item: T) => string
): Map<string, T[]> {
  // Bind rather than `.call` so the generic instantiation survives.
  const groupAsCommanderWould: (
    unsortedItems: T[],
    visibleItems: T[],
    getGroup: (item: T) => string
  ) => Map<string, T[]> = Help.prototype.groupItems.bind(this);
  const grouped = groupAsCommanderWould(unsortedItems, visibleItems, getGroup);
  const entries = [...grouped.entries()];
  const rank = (heading: string): number => GROUP_ORDER.indexOf(heading);
  const ours = entries.filter(([heading]) => rank(heading) !== -1);
  if (ours.length === 0) return grouped;
  const theirs = entries.filter(([heading]) => rank(heading) === -1);
  ours.sort((a, b) => rank(a[0]) - rank(b[0]));

  const ordered = ours.map(([heading, items]): [string, T[]] => {
    const declared = MEMBER_ORDER.get(heading);
    if (!declared) return [heading, items];
    const memberRank = (item: T): number => {
      const i = declared.indexOf(item.name());
      return i === -1 ? declared.length : i;
    };
    // Stable sort: unnamed members keep registration order behind the named ones.
    return [heading, [...items].sort((a, b) => memberRank(a) - memberRank(b))];
  });

  return new Map([...theirs, ...ordered]);
}

/**
 * Tag every registered subcommand with its job group and install the ordering
 * override. Call once, AFTER all subcommands have been added to `program`.
 */
export function applyJobGroupedHelp(program: Command): void {
  program.configureHelp({ groupItems: orderCommandGroups });
  // Anything not explicitly grouped — including Commander's built-in `help` command,
  // which is created lazily and never appears in `program.commands` — lands in Other,
  // so a command can never be hidden. `.helpCommand(true)` materializes that built-in
  // now so it picks up the default group.
  program.commandsGroup(groupHeading(OTHER_GROUP_TITLE));
  program.helpCommand(true);
  for (const sub of program.commands) {
    sub.helpGroup(groupHeading(groupForCommand(sub.name())));
  }
}
