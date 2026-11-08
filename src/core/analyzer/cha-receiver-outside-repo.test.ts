/**
 * CHA name-only refusal — a receiver statically known to live outside this repository
 * (change: suppress-false-cha-name-only).
 *
 * Failing-first cases taken verbatim in shape from the real indexes that found the defect:
 * grpc-go `service_config.go:177` (`json.Unmarshal` fanned onto four in-repo `Unmarshal`
 * methods, one of them on an unexported type in another binary's `package main`) and
 * requests `src/requests/utils.py:323` (`os.close(fd)` fanned onto four in-repo `close`
 * methods). The positive cases pin the other, equally unsound direction: a genuinely
 * unresolved in-repo receiver must still fan out, and no refusal may be silent.
 */
import { describe, it, expect } from 'vitest';
import { CallGraphBuilder } from './call-graph.js';
import type { CallEdge } from './call-graph.js';

type Built = Awaited<ReturnType<CallGraphBuilder['build']>>;
type File = { path: string; content: string; language: string };

const build = (files: File[]): Promise<Built> => new CallGraphBuilder().build(files);

const chaEdges = (b: Built, caller: string): CallEdge[] =>
  b.edges.filter(e => e.callerId === caller && e.synthesizedBy === 'cha-name-only');

const refusals = (b: Built) =>
  (b.ambiguousSites ?? []).filter(s => s.strategy === 'cha_receiver_outside_repo');

const GO_IN_REPO_CODEC: File = {
  path: 'codec/codec.go',
  language: 'Go',
  content: `package codec

type codecV0Bridge struct{}

func (c *codecV0Bridge) Unmarshal(data []byte, v any) error { return nil }
`,
};

describe('CHA refuses a receiver that is a package/module qualifier', () => {
  it('Go: json.Unmarshal is not fanned onto an in-repo Unmarshal method', async () => {
    const b = await build([
      {
        path: 'service_config.go',
        language: 'Go',
        content: `package grpc

import (
	"encoding/json"
)

type serviceConfig struct{ A int }

func parseServiceConfig(js string) error {
	var rsc serviceConfig
	return json.Unmarshal([]byte(js), &rsc)
}
`,
      },
      GO_IN_REPO_CODEC,
    ]);
    const caller = 'service_config.go::parseServiceConfig';
    // The site resolved correctly to the standard library and MUST NOT also claim an in-repo target.
    expect(b.edges.filter(e => e.callerId === caller && e.line === 11).map(e => e.calleeId))
      .toEqual(['external::json.Unmarshal']);
    expect(chaEdges(b, caller)).toHaveLength(0);
  });

  it('Python: os.close is not fanned onto in-repo close methods', async () => {
    const b = await build([
      {
        path: 'src/requests/utils.py',
        language: 'Python',
        content: `import os


def atomic_open(fd):
    os.close(fd)
`,
      },
      {
        path: 'src/requests/models.py',
        language: 'Python',
        content: `class Response:
    def close(self):
        return 1


class BaseAdapter:
    def close(self):
        return 2
`,
      },
    ]);
    const caller = 'src/requests/utils.py::atomic_open';
    expect(b.edges.filter(e => e.callerId === caller).map(e => e.calleeId))
      .toEqual(['external::os.close']);
    expect(chaEdges(b, caller)).toHaveLength(0);
  });

  it('Go: a receiver whose DECLARED type is qualified by a non-repo package is refused', async () => {
    const b = await build([
      {
        path: 'test/parse_config.go',
        language: 'Go',
        content: `package test

import (
	"testing"
)

func check(t *testing.T) {
	t.Fatalf("boom")
}
`,
      },
      {
        path: 'grpclog/component.go',
        language: 'Go',
        content: `package grpclog

type componentData struct{}

func (c *componentData) Fatalf(f string, a ...any) {}
`,
      },
    ]);
    expect(chaEdges(b, 'test/parse_config.go::check')).toHaveLength(0);
  });

  it('A qualifier that resolves INSIDE the repository is never refused', async () => {
    // `grpclog` is this repository's own package, so `grpclog.Component(...)` binds normally and
    // the receiver it returns stays eligible for name-only dispatch.
    const b = await build([
      {
        path: 'service_config.go',
        language: 'Go',
        content: `package grpc

import (
	"google.golang.org/grpc/grpclog"
)

func warn() {
	logger := grpclog.Component("core")
	logger.Warningf("x")
}
`,
      },
      {
        path: 'grpclog/component.go',
        language: 'Go',
        content: `package grpclog

type componentData struct{}

func (c *componentData) Warningf(f string, a ...any) {}

func Component(n string) *componentData { return &componentData{} }
`,
      },
    ]);
    expect(chaEdges(b, 'service_config.go::warn').map(e => e.calleeId))
      .toContain('grpclog/component.go::componentData.Warningf');
    expect(refusals(b)).toHaveLength(0);
  });

  it('CHA still fans out for a genuinely unresolved in-repo receiver', async () => {
    const b = await build([{
      path: 'src/shapes.ts',
      language: 'TypeScript',
      content: `
        class Shape { area() { return 0; } }
        class Circle extends Shape { area() { return 1; } }
        function loose(x) { return x.area(); }
      `,
    }]);
    const edges = chaEdges(b, 'src/shapes.ts::loose');
    expect(edges.map(e => e.calleeId).sort()).toEqual([
      'src/shapes.ts::Circle.area',
      'src/shapes.ts::Shape.area',
    ]);
    expect(refusals(b)).toHaveLength(0);
  });

  it('Go: an in-repo local receiver keeps its true name-only edge', async () => {
    // `r` is a local of an in-repo type. The old pass double-counted this site (an `external::r.CC`
    // leaf AND the real edge); the real edge is the correct one and must survive.
    const b = await build([
      {
        path: 'test/parse_config.go',
        language: 'Go',
        content: `package test

import (
	"google.golang.org/grpc/resolver/manual"
)

func run() {
	r := manual.NewBuilderWithScheme("x")
	_ = r.CC()
}
`,
      },
      {
        path: 'resolver/manual/manual.go',
        language: 'Go',
        content: `package manual

type Resolver struct{}

func (r *Resolver) CC() int { return 1 }

func NewBuilderWithScheme(s string) *Resolver { return &Resolver{} }
`,
      },
    ]);
    expect(chaEdges(b, 'test/parse_config.go::run').map(e => e.calleeId))
      .toEqual(['resolver/manual/manual.go::Resolver.CC']);
  });
});

describe('CHA refusals are disclosed, not silent', () => {
  it('A refused site reaches ambiguousSites naming the candidates declined', async () => {
    const b = await build([
      {
        path: 'service_config.go',
        language: 'Go',
        content: `package grpc

import (
	"encoding/json"
)

func parseServiceConfig(js string) error {
	var rsc int
	return json.Unmarshal([]byte(js), &rsc)
}
`,
      },
      GO_IN_REPO_CODEC,
    ]);
    const sites = refusals(b);
    expect(sites).toHaveLength(1);
    expect(sites[0]).toMatchObject({
      callerId: 'service_config.go::parseServiceConfig',
      calleeObject: 'json',
      calleeName: 'Unmarshal',
      strategy: 'cha_receiver_outside_repo',
    });
    // The in-repo method the pass declined to wire is still named, so the dead-code ambiguity
    // cap keeps firing for it — removing a false edge must not promote it to confidently dead.
    expect(sites[0].candidateIds).toContain('codec/codec.go::codecV0Bridge.Unmarshal');
  });
});
