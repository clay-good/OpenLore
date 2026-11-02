/**
 * The store's own rule, made enforceable (change: fix-schema-version-gate).
 *
 * `SCHEMA_VERSION`'s comment states why a new `edges.kind` or projected node `language` needs a
 * version bump even when it adds no column: `rawToCallEdge` DROPS a row whose `kind` it does not
 * know, so an OLDER OpenLore opening a NEWER store passes the version gate and then discards
 * those rows — serving the orphaned nodes as if they were code, and recomputing an `.olbundle`
 * digest through the same dropping reader so a valid bundle is rejected as TAMPERED.
 *
 * The rule was documented and then broken: three edge kinds and two node languages were added
 * across one release with the version left at 13, and both predicted symptoms were reproduced
 * against the published build. So the closed sets are pinned to the version here. Adding a kind
 * or a projected language fails this test until `SCHEMA_VERSION` is bumped and the list updated
 * together — which is the whole point.
 */
import { describe, it, expect } from 'vitest';
import { SCHEMA_VERSION } from './edge-store.js';
import { EDGE_KIND_VALUES } from '../analyzer/call-graph-types.js';
import { IAC_LANGUAGES } from '../analyzer/iac/types.js';
import { CONTRACT_LANGUAGES } from '../analyzer/contract/types.js';

/** Every `edges.kind` the store accepts as of the pinned schema version. */
const KINDS_AT_V14 = [
  'affects', 'authored_by', 'calls', 'changed_in_pr', 'consumes_endpoint', 'deploys_symbol',
  'depends_on', 'implements_endpoint', 'overrides', 'references', 'tested_by',
] as const;

/** Every projected (non-code) node `language` the store can hold as of the pinned version. */
const PROJECTED_LANGUAGES_AT_V14 = [
  'Ansible', 'Bicep', 'CDK', 'CDKTF', 'CloudFormation', 'Docker Compose', 'Dockerfile',
  'GitHub Actions', 'Helm', 'Kubernetes', 'OpenAPI', 'Pulumi', 'Serverless', 'Terraform',
] as const;

describe('the schema version gates the row shapes a reader must understand', () => {
  it('is the version these sets were last reviewed against', () => {
    expect(
      SCHEMA_VERSION,
      'SCHEMA_VERSION changed: review the two sets below and update them in the same commit.',
    ).toBe(14);
  });

  it('accepts exactly the edge kinds pinned to this version', () => {
    expect(
      [...EDGE_KIND_VALUES].sort(),
      'An edge kind was added or removed. An older OpenLore DROPS a row whose kind it does not '
      + 'know, so it would serve a newer store as if those edges did not exist and reject a valid '
      + '.olbundle as tampered. Bump SCHEMA_VERSION, say why in its comment, and update this list.',
    ).toEqual([...KINDS_AT_V14].sort());
  });

  it('carries exactly the projected node languages pinned to this version', () => {
    const projected = [...IAC_LANGUAGES, ...CONTRACT_LANGUAGES].sort();
    expect(
      projected,
      'A projected node language was added or removed. An older OpenLore has no predicate for it, '
      + 'so it ranks those declaration nodes as CODE — as hubs, entry points and insertion points. '
      + 'Bump SCHEMA_VERSION, say why in its comment, and update this list.',
    ).toEqual([...PROJECTED_LANGUAGES_AT_V14].sort());
  });
});
