import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const root = process.cwd();
const action = readFileSync(join(root, '.github/actions/openlore-review/action.yml'), 'utf-8');
const example = readFileSync(join(root, '.github/workflows/openlore-review.yml.example'), 'utf-8');
const actionDoc = parse(action) as { runs: { steps: Array<{ name?: string; id?: string; if?: string; env?: Record<string, string>; run?: string; with?: Record<string, string> }> } };
const exampleDoc = parse(example) as { jobs: { 'openlore-review': { steps: Array<{ uses?: string; with?: Record<string, string | boolean> }> } } };

describe('OpenLore review Action trust contract', () => {
  it('carries analyze failure state into the review command without failing the analyze step', () => {
    const analyze = actionDoc.runs.steps.find((step) => step.id === 'analyze');
    const review = actionDoc.runs.steps.find((step) => step.id === 'review');
    expect(analyze?.run).toContain('failed=true" >> "$GITHUB_OUTPUT"');
    expect(analyze?.run).not.toMatch(/exit\s+[^0]/);
    expect(review?.env?.OPENLORE_REVIEW_ANALYZE_FAILED).toBe('${{ steps.analyze.outputs.failed }}');
  });

  it('warns against elevated head analysis and documents the trusted split workflow', () => {
    expect(example).toMatch(/Do NOT switch[\s\S]*pull_request_target/);
    expect(example).toMatch(/pull_request[\s\S]*read-only[\s\S]*workflow_run[\s\S]*does[\s\S]*not check out or execute the head/i);
    expect(example).not.toContain('only safe because this Action runs deterministic local analysis');
    expect(example).toMatch(/workflow_run\.id[\s\S]*trusted run metadata[\s\S]*never the artifact[\s\S]*exactly one leading sticky marker/);
  });

  it('requires a reviewed immutable Action pin when the token can write', () => {
    expect(example).toContain('pull-requests: write');
    expect(example).toContain('@REPLACE_WITH_REVIEWED_COMMIT_SHA');
    expect(example).not.toContain('openlore-version:');
    expect(example).not.toMatch(/openlore-review@main/);
  });

  it('analyzes the declared PR head without persisting the write token in its checkout', () => {
    const steps = exampleDoc.jobs['openlore-review'].steps;
    const checkout = steps.find((step) => step.uses?.startsWith('actions/checkout@'));
    const openlore = steps.find((step) => step.uses?.startsWith('clay-good/OpenLore/'));
    expect(checkout?.with?.ref).toBe('${{ github.event.pull_request.head.sha }}');
    expect(checkout?.with?.['persist-credentials']).toBe(false);
    expect(openlore?.with?.head).toBe(checkout?.with?.ref);
  });

  it('retains comment size clamping and one-comment self-healing', () => {
    expect(action).toContain('if (body.length > MAX)');
    expect(action).toContain('body = body.slice(0, MAX - notice.length) + notice');
    expect(action).toContain('const matches = comments.filter');
    expect(action).toContain('for (const dup of matches.slice(1))');
    expect(action).toContain('deleteComment');
  });

  it('attempts to post gate evidence before propagating only the reserved policy exit', () => {
    const steps = actionDoc.runs.steps;
    const reviewIndex = steps.findIndex((step) => step.id === 'review');
    const postIndex = steps.findIndex((step) => step.name === 'Post or update the sticky review comment');
    const failIndex = steps.findIndex((step) => step.name === 'Fail after attempting gated briefing publication');
    expect(steps[reviewIndex]?.run).toContain('[ "$RC" -eq 3 ]');
    expect(steps[reviewIndex]?.run).not.toMatch(/\[ "\$RC" -eq 3 \][^\n]*-s "\$OUT"/);
    expect(steps[reviewIndex]?.run).not.toContain('exit "$RC"');
    expect(steps[reviewIndex]?.run).toContain('rm -f "$OUT"');
    expect(steps[postIndex]?.id).toBe('post');
    expect(steps[postIndex]?.if).not.toContain('always()');
    expect(steps[failIndex]?.if).toContain('always()');
    expect(steps[failIndex]?.if).toContain("steps.review.outputs.gated == 'true'");
    expect(steps[failIndex]?.if).not.toContain('steps.post.outputs');
    expect(reviewIndex).toBeLessThan(postIndex);
    expect(postIndex).toBeLessThan(failIndex);
    expect(action).toMatch(/blocking, frozen-new, uninitialized, or unverifiable blast-radius orphan enforcement/);
  });

  it('builds the SHA-pinned Action source with its committed dependency lockfile', () => {
    const build = actionDoc.runs.steps.find((step) => step.name === 'Build the SHA-pinned OpenLore Action source');
    expect(build?.env?.ACTION_PATH).toBe('${{ github.action_path }}');
    expect(build?.run).toContain('ACTION_PATH/../../..');
    expect(build?.run).toContain('package-lock.json');
    expect(build?.run).toContain('npm ci --ignore-scripts');
    expect(build?.run).toContain('npm run build');
    expect(build?.run).toContain('dist/cli/index.js');
    expect(action).not.toContain('openlore-version:');
    expect(action).not.toContain('npx ');
  });
});
