/**
 * An unexpected CLI failure must read as one legible message, not a V8 stack trace
 * (change: a path-confinement refusal during `install` printed the raw trace).
 *
 * Two facts carry this. The rendered text names what happened and, for a failure shape we
 * recognize, what to do about it — with the stack behind `--verbose`, never in the default
 * message. And the reporter must be BOUND before the command modules load, or a throw while
 * they evaluate escapes it; that is a property of `index.ts`'s import order, so it is
 * asserted against the source.
 */
import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { explainFailure, renderCrash } from './crash-report.js';

describe('renderCrash', () => {
  it('names the command and the message, and withholds the stack by default', () => {
    const error = new Error('boom');
    const text = renderCrash(error, { command: 'install' });
    expect(text).toContain('error: openlore install stopped: boom');
    expect(text).toContain('Re-run with --verbose for the stack trace.');
    expect(text).not.toContain('at ');
  });

  it('includes the stack under verbose, and then does not advertise the flag', () => {
    const text = renderCrash(new Error('boom'), { command: 'install', verbose: true });
    expect(text).toContain('crash-report.test');
    expect(text).not.toContain('Re-run with --verbose');
  });

  it('explains a path-confinement refusal in terms a user can act on', () => {
    const text = renderCrash(
      new Error('Path escape blocked: "CLAUDE.md" canonicalizes outside the project directory'),
      { command: 'install' },
    );
    expect(text).toContain('symbolic link resolving outside');
    expect(text).toContain('--agent');
  });

  it('renders a non-Error throw without inventing a message', () => {
    expect(renderCrash('plain string failure')).toContain('plain string failure');
    expect(renderCrash(undefined)).toContain('an unknown error');
  });

  it('strips terminal escapes out of the message', () => {
    const text = renderCrash(new Error('\u001b[31mred\u001b[0m'));
    expect(text).not.toContain('\u001b[31m');
    expect(text).toContain('red');
  });
});

describe('explainFailure', () => {
  it('recognizes the failures a first run actually hits', () => {
    expect(explainFailure('EACCES: permission denied')).toContain('not writable');
    expect(explainFailure('ENOSPC: no space left on device')).toContain('filesystem is full');
    expect(explainFailure('EMFILE: too many open files')).toContain('file descriptors');
  });

  it('adds nothing when there is nothing honest to add', () => {
    expect(explainFailure('Cannot read properties of undefined')).toBeNull();
  });
});

describe('the reporter is bound before the command modules load', () => {
  it('index.ts imports crash-reporter ahead of its first command module', async () => {
    const source = await readFile(join(import.meta.dirname, 'index.ts'), 'utf8');
    const reporter = source.indexOf("import './crash-reporter.js'");
    const firstCommand = source.indexOf("from './commands/");
    expect(reporter).toBeGreaterThan(-1);
    expect(firstCommand).toBeGreaterThan(-1);
    expect(reporter).toBeLessThan(firstCommand);
  });
});
