/**
 * Drop Node's one-line "SQLite is an experimental feature" warning (Node 22; Node 24 and later do
 * not print it). The graph store uses `node:sqlite`, so without this filter every command on
 * Node 22 writes the warning to stderr, including each agent-loop hook, which must write nothing
 * (change: hook-reliability). Every other warning is printed as before.
 *
 * Imported first by the CLI entry: Node emits the warning on a later tick, after the module graph
 * has loaded, so the filter is in place when it fires.
 */
type Emit = (event: string | symbol, ...args: unknown[]) => boolean;

const emit = process.emit as unknown as Emit;
(process as unknown as { emit: Emit }).emit = function filtered(this: NodeJS.Process, event, ...args) {
  const warning = args[0] as { name?: unknown; message?: unknown } | undefined;
  if (event === 'warning' && warning?.name === 'ExperimentalWarning' && typeof warning.message === 'string' && warning.message.startsWith('SQLite ')) {
    return false;
  }
  return emit.call(this, event, ...args);
};
