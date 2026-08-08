/**
 * Dynamic-dispatch edge synthesis (spec: add-synthesized-dynamic-dispatch-edges).
 * Tests the event-channel and route-handler rules + provenance through the real
 * CallGraphBuilder.build(). Route tests use on-disk fixtures because route
 * detection reads from disk by path (as the existing HTTP edge pass does).
 * Plain .test.ts so CI runs it.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CallGraphBuilder, EVENT_CHANNEL_FANOUT_CAP } from './call-graph.js';
import type { CallEdge, FunctionNode } from './call-graph.js';

type Built = Awaited<ReturnType<CallGraphBuilder['build']>>;
const idByName = (b: Built, name: string): string | undefined =>
  [...b.nodes.values()].find((n: FunctionNode) => n.name === name)?.id;
const synthEdges = (b: Built): CallEdge[] => b.edges.filter(e => e.confidence === 'synthesized');
const edgeBetween = (b: Built, fromName: string, toName: string): CallEdge | undefined => {
  const from = idByName(b, fromName), to = idByName(b, toName);
  return b.edges.find(e => e.callerId === from && e.calleeId === to);
};

describe('event-channel synthesis', () => {
  const build = (content: string): Promise<Built> =>
    new CallGraphBuilder().build([{ path: 'src/app.ts', content, language: 'TypeScript' }]);

  it('Event handler is reachable through a synthesized edge', async () => {
    const b = await build(`
      function onMount() { return 1; }
      function register(emitter: any) { emitter.on('mount', onMount); }
      function trigger(emitter: any) { emitter.emit('mount'); }
    `);
    const edge = edgeBetween(b, 'trigger', 'onMount');
    expect(edge).toBeDefined();
    expect(edge!.confidence).toBe('synthesized');
    expect(edge!.synthesizedBy).toBe('event-channel');
    expect(edge!.kind).toBe('calls');
  });

  it('TSX event handlers remain reachable through synthesized edges', async () => {
    const b = await new CallGraphBuilder().build([{
      path: 'src/app.tsx',
      language: 'TypeScript',
      content: `
        function onMount() { return <span />; }
        function register(emitter: any) { emitter.on('mount', onMount); return <div />; }
        function trigger(emitter: any) { emitter.emit('mount'); return <main />; }
      `,
    }]);

    expect(edgeBetween(b, 'trigger', 'onMount')?.synthesizedBy).toBe('event-channel');
  });

  it('selects the grammar per file in a mixed TypeScript and TSX batch', async () => {
    const b = await new CallGraphBuilder().build([
      {
        path: 'src/register.ts',
        language: 'TypeScript',
        content: `
          function onSave() { return 1; }
          function register(emitter: any) {
            const count = <number>1;
            emitter.on('save', onSave);
            return count;
          }
        `,
      },
      {
        path: 'src/trigger.tsx',
        language: 'TypeScript',
        content: `function trigger(emitter: any) { emitter.emit('save'); return <main />; }`,
      },
    ]);

    expect(edgeBetween(b, 'trigger', 'onSave')?.synthesizedBy).toBe('event-channel');
  });

  it('Mismatched channel keys produce no edge', async () => {
    const b = await build(`
      function handler() { return 1; }
      function register(e: any) { e.on('open', handler); }
      function trigger(e: any) { e.emit('close'); }
    `);
    expect(edgeBetween(b, 'trigger', 'handler')).toBeUndefined();
    expect(synthEdges(b)).toHaveLength(0);
  });

  it('Unpaired dispatch emits nothing', async () => {
    const b = await build(`
      function trigger(e: any) { e.emit('change'); }
    `);
    expect(synthEdges(b)).toHaveLength(0);
  });

  it('addEventListener registration is recognized', async () => {
    const b = await build(`
      function onClick() { return 1; }
      function wire(el: any) { el.addEventListener('click', onClick); }
      function fire(el: any) { el.dispatch('click'); }
    `);
    const edge = edgeBetween(b, 'fire', 'onClick');
    expect(edge?.synthesizedBy).toBe('event-channel');
  });

  it('Over-cap channel is dropped, not guessed', async () => {
    const handlers = Array.from({ length: EVENT_CHANNEL_FANOUT_CAP + 1 }, (_, i) => `function h${i}() { return ${i}; }`).join('\n');
    const regs = Array.from({ length: EVENT_CHANNEL_FANOUT_CAP + 1 }, (_, i) => `e.on('busy', h${i});`).join('\n');
    const b = await build(`
      ${handlers}
      function register(e: any) { ${regs} }
      function trigger(e: any) { e.emit('busy'); }
    `);
    // Over the cap → channel dropped entirely, no synthesized edges for it.
    expect(synthEdges(b).filter(e => e.synthesizedBy === 'event-channel')).toHaveLength(0);
  });

  it('At-cap channel still wires (boundary)', async () => {
    const handlers = Array.from({ length: EVENT_CHANNEL_FANOUT_CAP }, (_, i) => `function g${i}() { return ${i}; }`).join('\n');
    const regs = Array.from({ length: EVENT_CHANNEL_FANOUT_CAP }, (_, i) => `e.on('ok', g${i});`).join('\n');
    const b = await build(`
      ${handlers}
      function register(e: any) { ${regs} }
      function trigger(e: any) { e.emit('ok'); }
    `);
    expect(synthEdges(b).length).toBe(EVENT_CHANNEL_FANOUT_CAP);
  });

  it('Synthesized edge carries provenance; direct edges do not', async () => {
    const b = await build(`
      function onMount() { return 1; }
      function helper() { return onMount(); }
      function register(e: any) { e.on('mount', onMount); }
      function trigger(e: any) { e.emit('mount'); }
    `);
    for (const e of b.edges) {
      if (e.confidence === 'synthesized') expect(e.synthesizedBy).toBeTruthy();
      else expect(e.synthesizedBy).toBeUndefined();
    }
    // The direct call helper → onMount stays directly-resolved.
    const direct = edgeBetween(b, 'helper', 'onMount');
    expect(direct?.confidence).not.toBe('synthesized');
    expect(direct?.synthesizedBy).toBeUndefined();
  });

  it('Cross-file registration and dispatch pair by key', async () => {
    const b = await new CallGraphBuilder().build([
      { path: 'src/handlers.ts', content: 'export function onSave() { return 1; }', language: 'TypeScript' },
      { path: 'src/wire.ts', content: `import { onSave } from './handlers';\nfunction reg(e: any) { e.on('save', onSave); }`, language: 'TypeScript' },
      { path: 'src/fire.ts', content: `function go(e: any) { e.emit('save'); }`, language: 'TypeScript' },
    ]);
    const edge = edgeBetween(b, 'go', 'onSave');
    expect(edge?.synthesizedBy).toBe('event-channel');
  });

  it('resolves a member-expression handler (this.fn / obj.fn)', async () => {
    const b = await build(`
      function onMount() { return 1; }
      function register(e: any) { e.on('mount', this.onMount); }
      function trigger(e: any) { e.emit('mount'); }
    `);
    expect(edgeBetween(b, 'trigger', 'onMount')?.synthesizedBy).toBe('event-channel');
  });

  it('unwraps a .bind() handler reference', async () => {
    const b = await build(`
      function onMount() { return 1; }
      function register(e: any) { e.on('mount', onMount.bind(this)); }
      function trigger(e: any) { e.emit('mount'); }
    `);
    expect(edgeBetween(b, 'trigger', 'onMount')?.synthesizedBy).toBe('event-channel');
  });

  it('wires an inline arrow handler to the functions its body calls', async () => {
    const b = await build(`
      function realHandler() { return 1; }
      function register(e: any) { e.on('mount', () => { realHandler(); }); }
      function trigger(e: any) { e.emit('mount'); }
    `);
    expect(edgeBetween(b, 'trigger', 'realHandler')?.synthesizedBy).toBe('event-channel');
  });

  it('pairs on a constant member-expression key (EVENTS.MOUNT)', async () => {
    const b = await build(`
      const EVENTS = { MOUNT: 'mount' };
      function onMount() { return 1; }
      function register(e: any) { e.on(EVENTS.MOUNT, onMount); }
      function trigger(e: any) { e.emit(EVENTS.MOUNT); }
    `);
    expect(edgeBetween(b, 'trigger', 'onMount')?.synthesizedBy).toBe('event-channel');
  });

  it('pairs on a substitution-free template-literal key', async () => {
    const b = await build([
      'function onMount() { return 1; }',
      'function register(e: any) { e.on(`mount`, onMount); }',
      'function trigger(e: any) { e.emit(`mount`); }',
    ].join('\n'));
    expect(edgeBetween(b, 'trigger', 'onMount')?.synthesizedBy).toBe('event-channel');
  });

  it('does NOT pair a string key with a same-text constant key (namespace isolation)', async () => {
    const b = await build(`
      const EVENTS = { MOUNT: 'mount' };
      function onMount() { return 1; }
      function register(e: any) { e.on(EVENTS.MOUNT, onMount); }
      function trigger(e: any) { e.emit('EVENTS.MOUNT'); }
    `);
    // 'EVENTS.MOUNT' (string) must not pair with EVENTS.MOUNT (constant ref).
    expect(edgeBetween(b, 'trigger', 'onMount')).toBeUndefined();
  });

  it('ignores a computed/dynamic dispatch key (no guess)', async () => {
    const b = await build(`
      function onMount() { return 1; }
      function register(e: any) { e.on('mount', onMount); }
      function trigger(e: any, k: string) { e.emit(k); }
    `);
    expect(synthEdges(b)).toHaveLength(0);
  });

  it('supports pub/sub verbs (subscribe / publish)', async () => {
    const b = await build(`
      function onTopic() { return 1; }
      function register(bus: any) { bus.subscribe('topic', onTopic); }
      function fire(bus: any) { bus.publish('topic'); }
    `);
    expect(edgeBetween(b, 'fire', 'onTopic')?.synthesizedBy).toBe('event-channel');
  });

  it('supports DOM dispatchEvent(new CustomEvent(k)) key extraction', async () => {
    const b = await build(`
      function onClick() { return 1; }
      function wire(el: any) { el.addEventListener('click', onClick); }
      function fire(el: any) { el.dispatchEvent(new CustomEvent('click')); }
    `);
    expect(edgeBetween(b, 'fire', 'onClick')?.synthesizedBy).toBe('event-channel');
  });

  it('ignores a keyless RxJS-style subscribe(fn) (no false edge)', async () => {
    const b = await build(`
      function onNext() { return 1; }
      function register(obs: any) { obs.subscribe(onNext); }
      function fire(obs: any) { obs.emit('whatever'); }
    `);
    // subscribe(fn) has no string key → no registration → no synthesized edge.
    expect(synthEdges(b)).toHaveLength(0);
  });

  it('sets the dispatch-site line on the synthesized edge', async () => {
    const b = await build(`function onMount() { return 1; }
function register(e: any) { e.on('mount', onMount); }
function trigger(e: any) { e.emit('mount'); }`);
    const edge = edgeBetween(b, 'trigger', 'onMount');
    expect(typeof edge!.line).toBe('number');
    expect(edge!.line).toBeGreaterThan(0);
  });

  it('synthesized edges do NOT perturb fanIn/fanOut (structural metrics stay directly-resolved)', async () => {
    const b = await build(`
      function onMount() { return 1; }
      function register(e: any) { e.on('mount', onMount); }
      function trigger(e: any) { e.emit('mount'); }
    `);
    // The synthesized edge exists (reachability preserved)...
    expect(edgeBetween(b, 'trigger', 'onMount')?.confidence).toBe('synthesized');
    // ...but onMount has no DIRECT caller, so its fanIn stays 0 (synthesized excluded).
    const onMount = [...b.nodes.values()].find(n => n.name === 'onMount');
    expect(onMount?.fanIn).toBe(0);
  });

  it('Direct edges are unchanged by synthesis (only added edges differ)', async () => {
    const content = `
      function onMount() { return 1; }
      function helper() { return onMount(); }
      function register(e: any) { e.on('mount', onMount); }
      function trigger(e: any) { e.emit('mount'); }
    `;
    const b = await build(content);
    const directEdges = b.edges.filter(e => e.confidence !== 'synthesized');
    // Every directly-resolved edge is a real call-resolution edge (no synthesized leakage).
    expect(directEdges.every(e => e.synthesizedBy === undefined)).toBe(true);
    // The synthesis added at least one edge on top of the direct graph.
    expect(synthEdges(b).length).toBeGreaterThan(0);
    expect(b.edges.length).toBe(directEdges.length + synthEdges(b).length);
  });
});

describe('event-channel synthesis — Python', () => {
  const buildPy = (content: string): Promise<Built> =>
    new CallGraphBuilder().build([{ path: 'app.py', content, language: 'Python' }]);

  it('Python event handler is reachable through a synthesized edge', async () => {
    const b = await buildPy([
      'def on_mount():',
      '    return 1',
      'def register(emitter):',
      "    emitter.on('mount', on_mount)",
      'def trigger(emitter):',
      "    emitter.emit('mount')",
    ].join('\n'));
    const edge = edgeBetween(b, 'trigger', 'on_mount');
    expect(edge?.confidence).toBe('synthesized');
    expect(edge?.synthesizedBy).toBe('event-channel');
  });

  it('Python mismatched channel keys produce no edge', async () => {
    const b = await buildPy([
      'def handler():',
      '    return 1',
      'def register(e):',
      "    e.on('open', handler)",
      'def trigger(e):',
      "    e.emit('close')",
    ].join('\n'));
    expect(edgeBetween(b, 'trigger', 'handler')).toBeUndefined();
    expect(synthEdges(b)).toHaveLength(0);
  });

  it('resolves a Python self.method handler (attribute)', async () => {
    const b = await buildPy([
      'class C:',
      '    def on_mount(self):',
      '        return 1',
      '    def register(self, e):',
      "        e.on('mount', self.on_mount)",
      '    def trigger(self, e):',
      "        e.emit('mount')",
    ].join('\n'));
    expect(edgeBetween(b, 'trigger', 'on_mount')?.synthesizedBy).toBe('event-channel');
  });

  it('wires a Python inline lambda handler to the functions its body calls', async () => {
    const b = await buildPy([
      'def real_handler():',
      '    return 1',
      'def register(e):',
      "    e.on('mount', lambda: real_handler())",
      'def trigger(e):',
      "    e.emit('mount')",
    ].join('\n'));
    expect(edgeBetween(b, 'trigger', 'real_handler')?.synthesizedBy).toBe('event-channel');
  });

  it('supports Python pub/sub verbs (subscribe / publish)', async () => {
    const b = await buildPy([
      'def on_topic():',
      '    return 1',
      'def register(bus):',
      "    bus.subscribe('topic', on_topic)",
      'def fire(bus):',
      "    bus.publish('topic')",
    ].join('\n'));
    expect(edgeBetween(b, 'fire', 'on_topic')?.synthesizedBy).toBe('event-channel');
  });

  it('pairs on a Python constant member key (Events.MOUNT)', async () => {
    const b = await buildPy([
      'def on_mount():',
      '    return 1',
      'def register(e):',
      '    e.on(Events.MOUNT, on_mount)',
      'def trigger(e):',
      '    e.emit(Events.MOUNT)',
    ].join('\n'));
    expect(edgeBetween(b, 'trigger', 'on_mount')?.synthesizedBy).toBe('event-channel');
  });

  it('ignores a Python f-string (interpolated) key — no guess', async () => {
    const b = await buildPy([
      'def on_mount():',
      '    return 1',
      'def register(e, x):',
      "    e.on(f'mount-{x}', on_mount)",
      'def trigger(e, x):',
      "    e.emit(f'mount-{x}')",
    ].join('\n'));
    expect(synthEdges(b)).toHaveLength(0);
  });
});

describe('event-channel synthesis — Ruby', () => {
  const buildRb = (content: string): Promise<Built> =>
    new CallGraphBuilder().build([{ path: 'app.rb', content, language: 'Ruby' }]);

  it('Ruby symbol-keyed on/emit with a block handler is reachable', async () => {
    const b = await buildRb([
      'def handler',
      '  do_work',
      'end',
      'def register(e)',
      '  e.on(:mount) { handler }',
      'end',
      'def trigger(e)',
      '  e.emit(:mount)',
      'end',
    ].join('\n'));
    const edge = edgeBetween(b, 'trigger', 'handler');
    expect(edge?.confidence).toBe('synthesized');
    expect(edge?.synthesizedBy).toBe('event-channel');
  });

  it('Ruby mismatched symbol keys produce no edge', async () => {
    const b = await buildRb([
      'def handler',
      '  do_work',
      'end',
      'def register(e)',
      '  e.on(:open) { handler }',
      'end',
      'def trigger(e)',
      '  e.emit(:close)',
      'end',
    ].join('\n'));
    expect(edgeBetween(b, 'trigger', 'handler')).toBeUndefined();
    expect(synthEdges(b)).toHaveLength(0);
  });

  it('Ruby ActiveSupport::Notifications subscribe/instrument (string key, block handler)', async () => {
    const b = await buildRb([
      'def handle_created',
      '  do_work',
      'end',
      'def register',
      "  ActiveSupport::Notifications.subscribe('user.created') { handle_created }",
      'end',
      'def trigger',
      "  ActiveSupport::Notifications.instrument('user.created') { save }",
      'end',
    ].join('\n'));
    expect(edgeBetween(b, 'trigger', 'handle_created')?.synthesizedBy).toBe('event-channel');
  });

  it('Ruby symbol key does not pair with a same-text string key', async () => {
    const b = await buildRb([
      'def handler',
      '  do_work',
      'end',
      'def register(e)',
      '  e.on(:mount) { handler }',
      'end',
      'def trigger(e)',
      "  e.emit('mount')",
      'end',
    ].join('\n'));
    // :mount (sym:) must not pair with 'mount' (str:).
    expect(edgeBetween(b, 'trigger', 'handler')).toBeUndefined();
  });
});

describe('event-channel synthesis — PHP', () => {
  const buildPhp = (content: string): Promise<Built> =>
    new CallGraphBuilder().build([{ path: 'app.php', content, language: 'PHP' }]);

  it('Laravel Event::listen with a string callable is reachable', async () => {
    const b = await buildPhp([
      '<?php',
      'function on_created() { do_work(); }',
      'function register() {',
      "  Event::listen('user.created', 'on_created');",
      '}',
      'function trigger() {',
      "  Event::dispatch('user.created');",
      '}',
    ].join('\n'));
    const edge = edgeBetween(b, 'trigger', 'on_created');
    expect(edge?.confidence).toBe('synthesized');
    expect(edge?.synthesizedBy).toBe('event-channel');
  });

  it('Laravel closure handler + event() helper dispatch', async () => {
    const b = await buildPhp([
      '<?php',
      'function on_updated() { do_work(); }',
      'function register() {',
      "  Event::listen('user.updated', function() { on_updated(); });",
      '}',
      'function trigger() {',
      "  event('user.updated');",
      '}',
    ].join('\n'));
    expect(edgeBetween(b, 'trigger', 'on_updated')?.synthesizedBy).toBe('event-channel');
  });

  it('Symfony addListener with a [$this, method] array callable', async () => {
    const b = await buildPhp([
      '<?php',
      'class C {',
      '  function on_x() { do_work(); }',
      '  function register($d) {',
      "    $d->addListener('x', [$this, 'on_x']);",
      '  }',
      '  function trigger($d) {',
      "    $d->dispatch('x');",
      '  }',
      '}',
    ].join('\n'));
    expect(edgeBetween(b, 'trigger', 'on_x')?.synthesizedBy).toBe('event-channel');
  });

  it('PHP mismatched keys produce no edge', async () => {
    const b = await buildPhp([
      '<?php',
      'function handler() { do_work(); }',
      'function register() {',
      "  Event::listen('open', 'handler');",
      '}',
      'function trigger() {',
      "  Event::dispatch('close');",
      '}',
    ].join('\n'));
    expect(edgeBetween(b, 'trigger', 'handler')).toBeUndefined();
    expect(synthEdges(b)).toHaveLength(0);
  });
});

describe('type-based event synthesis — Java', () => {
  const buildJava = (content: string): Promise<Built> =>
    new CallGraphBuilder().build([{ path: 'App.java', content, language: 'Java' }]);

  it('@Subscribe handler is reachable from post(new T())', async () => {
    const b = await buildJava([
      'class Listeners {',
      '  @Subscribe',
      '  public void onUserCreated(UserCreatedEvent e) { doWork(); }',
      '}',
      'class Publisher {',
      '  void go(EventBus bus) { bus.post(new UserCreatedEvent("a")); }',
      '}',
    ].join('\n'));
    const edge = edgeBetween(b, 'go', 'onUserCreated');
    expect(edge?.confidence).toBe('synthesized');
    expect(edge?.synthesizedBy).toBe('type-event');
  });

  it('@EventListener handler is reachable from publishEvent(new T())', async () => {
    const b = await buildJava([
      'class Listeners {',
      '  @EventListener',
      '  void handle(OrderPlaced ev) { ship(); }',
      '}',
      'class Pub {',
      '  void go(ApplicationEventPublisher p) { p.publishEvent(new OrderPlaced()); }',
      '}',
    ].join('\n'));
    expect(edgeBetween(b, 'go', 'handle')?.synthesizedBy).toBe('type-event');
  });

  it('Java mismatched event types produce no edge', async () => {
    const b = await buildJava([
      'class Listeners {',
      '  @Subscribe',
      '  void onA(EventA e) { work(); }',
      '}',
      'class Publisher {',
      '  void go(EventBus bus) { bus.post(new EventB()); }',
      '}',
    ].join('\n'));
    expect(edgeBetween(b, 'go', 'onA')).toBeUndefined();
    expect(synthEdges(b)).toHaveLength(0);
  });

  it('an un-annotated method with the event type is NOT a handler', async () => {
    const b = await buildJava([
      'class Listeners {',
      '  void onUserCreated(UserCreatedEvent e) { doWork(); }', // no @Subscribe
      '}',
      'class Publisher {',
      '  void go(EventBus bus) { bus.post(new UserCreatedEvent()); }',
      '}',
    ].join('\n'));
    expect(synthEdges(b)).toHaveLength(0);
  });
});

describe('type-based event synthesis — C#', () => {
  const buildCs = (content: string): Promise<Built> =>
    new CallGraphBuilder().build([{ path: 'App.cs', content, language: 'C#' }]);

  it('INotificationHandler<T> handler is reachable from Publish(new T())', async () => {
    const b = await buildCs([
      'public class UserCreatedHandler : INotificationHandler<UserCreatedEvent> {',
      '  public Task Handle(UserCreatedEvent n, CancellationToken c) { DoWork(); return Task.CompletedTask; }',
      '}',
      'public class Publisher {',
      '  void Go(IMediator mediator) { mediator.Publish(new UserCreatedEvent("a")); }',
      '}',
    ].join('\n'));
    const edge = edgeBetween(b, 'Go', 'Handle');
    expect(edge?.confidence).toBe('synthesized');
    expect(edge?.synthesizedBy).toBe('type-event');
  });

  it('IRequestHandler<T> + Send(new T())', async () => {
    const b = await buildCs([
      'public class CreateOrderHandler : IRequestHandler<CreateOrder, Unit> {',
      '  public Task<Unit> Handle(CreateOrder request, CancellationToken c) { Save(); return Unit.Task; }',
      '}',
      'public class Caller {',
      '  void Go(IMediator m) { m.Send(new CreateOrder()); }',
      '}',
    ].join('\n'));
    expect(edgeBetween(b, 'Go', 'Handle')?.synthesizedBy).toBe('type-event');
  });

  it('C# mismatched event types produce no edge', async () => {
    const b = await buildCs([
      'public class AHandler : INotificationHandler<EventA> {',
      '  public Task Handle(EventA n, CancellationToken c) { Work(); return Task.CompletedTask; }',
      '}',
      'public class Publisher {',
      '  void Go(IMediator m) { m.Publish(new EventB()); }',
      '}',
    ].join('\n'));
    expect(synthEdges(b)).toHaveLength(0);
  });
});

describe('type-based event synthesis — Kotlin', () => {
  const buildKt = (content: string): Promise<Built> =>
    new CallGraphBuilder().build([{ path: 'App.kt', content, language: 'Kotlin' }]);

  it('@Subscribe handler is reachable from post(T())', async () => {
    const b = await buildKt([
      'class Listeners {',
      '  @Subscribe',
      '  fun onUserCreated(e: UserCreatedEvent) { doWork() }',
      '}',
      'class Publisher {',
      '  fun go(bus: EventBus) { bus.post(UserCreatedEvent("a")) }',
      '}',
    ].join('\n'));
    const edge = edgeBetween(b, 'go', 'onUserCreated');
    expect(edge?.confidence).toBe('synthesized');
    expect(edge?.synthesizedBy).toBe('type-event');
  });

  it('Kotlin mismatched event types produce no edge', async () => {
    const b = await buildKt([
      'class Listeners {',
      '  @Subscribe',
      '  fun onA(e: EventA) { work() }',
      '}',
      'class Publisher {',
      '  fun go(bus: EventBus) { bus.post(EventB()) }',
      '}',
    ].join('\n'));
    expect(synthEdges(b)).toHaveLength(0);
  });

  it('Kotlin un-annotated method is not a handler', async () => {
    const b = await buildKt([
      'class Listeners {',
      '  fun onUserCreated(e: UserCreatedEvent) { doWork() }',
      '}',
      'class Publisher {',
      '  fun go(bus: EventBus) { bus.post(UserCreatedEvent()) }',
      '}',
    ].join('\n'));
    expect(synthEdges(b)).toHaveLength(0);
  });
});

describe('event-channel synthesis — Swift (NotificationCenter)', () => {
  const buildSwift = (content: string): Promise<Built> =>
    new CallGraphBuilder().build([{ path: 'App.swift', content, language: 'Swift' }]);

  it('addObserver(forName:){closure} is reachable from post(name:)', async () => {
    const b = await buildSwift([
      'class C {',
      '  func onMount() { doWork() }',
      '  func register() {',
      '    NotificationCenter.default.addObserver(forName: Notification.Name("mount"), object: nil, queue: nil) { note in self.onMount() }',
      '  }',
      '  func trigger() {',
      '    NotificationCenter.default.post(name: Notification.Name("mount"), object: nil)',
      '  }',
      '}',
    ].join('\n'));
    const edge = edgeBetween(b, 'trigger', 'onMount');
    expect(edge?.confidence).toBe('synthesized');
    expect(edge?.synthesizedBy).toBe('event-channel');
  });

  it('Swift mismatched notification names produce no edge', async () => {
    const b = await buildSwift([
      'class C {',
      '  func onMount() { doWork() }',
      '  func register() {',
      '    NotificationCenter.default.addObserver(forName: Notification.Name("open"), object: nil, queue: nil) { note in self.onMount() }',
      '  }',
      '  func trigger() {',
      '    NotificationCenter.default.post(name: Notification.Name("close"), object: nil)',
      '  }',
      '}',
    ].join('\n'));
    expect(edgeBetween(b, 'trigger', 'onMount')).toBeUndefined();
    expect(synthEdges(b)).toHaveLength(0);
  });
});

describe('callback-registration synthesis', () => {
  it('Go: http.HandleFunc / mux.HandleFunc / router.GET wire named handlers', async () => {
    const b = await new CallGraphBuilder().build([{ path: 'main.go', language: 'Go', content: [
      'package main',
      'func handleX(w http.ResponseWriter, r *http.Request) {}',
      'func handleZ(w http.ResponseWriter, r *http.Request) {}',
      'func setup(mux *http.ServeMux, r *gin.Engine) {',
      '  mux.HandleFunc("/x", handleX)',
      '  r.GET("/z", handleZ)',
      '}',
    ].join('\n') }]);
    expect(edgeBetween(b, 'setup', 'handleX')?.synthesizedBy).toBe('callback-registration');
    expect(edgeBetween(b, 'setup', 'handleZ')?.synthesizedBy).toBe('callback-registration');
  });

  it('Go: a function passed to a non-registrar is not a callback', async () => {
    const b = await new CallGraphBuilder().build([{ path: 'main.go', language: 'Go', content: [
      'package main',
      'func helper() {}',
      'func setup() { register(helper) }', // `register` is not a curated registrar
    ].join('\n') }]);
    expect(synthEdges(b)).toHaveLength(0);
  });

  it('JS/TS: setTimeout/setInterval with a named function wire the callback', async () => {
    const b = await new CallGraphBuilder().build([{ path: 'app.ts', language: 'TypeScript', content: [
      'function tick() { return 1; }',
      'function poll() { return 2; }',
      'function start() { setTimeout(tick, 1000); setInterval(poll, 500); }',
    ].join('\n') }]);
    expect(edgeBetween(b, 'start', 'tick')?.synthesizedBy).toBe('callback-registration');
    expect(edgeBetween(b, 'start', 'poll')?.synthesizedBy).toBe('callback-registration');
  });

  it('TSX: setTimeout with a named function wires the callback', async () => {
    const b = await new CallGraphBuilder().build([{
      path: 'app.tsx',
      language: 'TypeScript',
      content: [
        'function tick() { return <span />; }',
        'function start() { setTimeout(tick, 1000); return <main />; }',
      ].join('\n'),
    }]);

    expect(edgeBetween(b, 'start', 'tick')?.synthesizedBy).toBe('callback-registration');
  });

  it('JS/TS: an inline arrow to setTimeout is NOT a callback-registration edge (direct resolution covers it)', async () => {
    const b = await new CallGraphBuilder().build([{ path: 'app.ts', language: 'TypeScript', content: [
      'function realTick() { return 1; }',
      'function start() { setTimeout(() => realTick(), 1000); }',
    ].join('\n') }]);
    // No callback-registration edge from the inline arrow (the arrow body call is a direct edge).
    expect(synthEdges(b).filter(e => e.synthesizedBy === 'callback-registration')).toHaveLength(0);
  });

  it('does NOT wire a Promise resolve/reject local to a coincidentally same-named function', async () => {
    // Regression: `setTimeout(resolve, ms)` inside `new Promise((resolve) => …)` — `resolve`
    // is the executor parameter, NOT a registered handler. It must not wire to an unrelated
    // function named `resolve` elsewhere (the real false positive found on the OpenLore repo).
    const b = await new CallGraphBuilder().build([
      { path: 'helpers.ts', language: 'TypeScript', content: 'export const resolve = (m: number) => m + 1;' },
      { path: 'sleep.ts', language: 'TypeScript', content: 'export function sleep(ms: number) { return new Promise((resolve) => setTimeout(resolve, ms)); }' },
    ]);
    expect(synthEdges(b).filter(e => e.synthesizedBy === 'callback-registration')).toHaveLength(0);
  });

  it('still wires a genuinely-named handler (not a runtime-local name) to a scheduler', async () => {
    const b = await new CallGraphBuilder().build([{ path: 'app.ts', language: 'TypeScript', content: [
      'function pollStatus() { return 1; }',
      'function start() { setInterval(pollStatus, 1000); }',
    ].join('\n') }]);
    expect(edgeBetween(b, 'start', 'pollStatus')?.synthesizedBy).toBe('callback-registration');
  });

  it('C++: Qt connect wires the slot member function (not the signal)', async () => {
    const b = await new CallGraphBuilder().build([{ path: 'w.cpp', language: 'C++', content: [
      'class MyWidget {',
      '  void onClicked() { doWork(); }',
      '  void setup(QPushButton* button) {',
      '    connect(button, &QPushButton::clicked, this, &MyWidget::onClicked);',
      '  }',
      '};',
    ].join('\n') }]);
    const edge = edgeBetween(b, 'setup', 'onClicked');
    expect(edge?.synthesizedBy).toBe('callback-registration');
    // The Qt signal `clicked` is external (no body) → not wired as a handler.
    expect(edgeBetween(b, 'setup', 'clicked')).toBeUndefined();
  });

  it('C++: QObject::connect form is also recognized', async () => {
    const b = await new CallGraphBuilder().build([{ path: 'w.cpp', language: 'C++', content: [
      'class MyWidget {',
      '  void onPressed() { handle(); }',
      '  void setup(QPushButton* button) {',
      '    QObject::connect(button, &QPushButton::pressed, this, &MyWidget::onPressed);',
      '  }',
      '};',
    ].join('\n') }]);
    expect(edgeBetween(b, 'setup', 'onPressed')?.synthesizedBy).toBe('callback-registration');
  });
});

describe('actor-message synthesis — Elixir GenServer', () => {
  const buildEx = (content: string): Promise<Built> =>
    new CallGraphBuilder().build([{ path: 'server.ex', content, language: 'Elixir' }]);

  it('GenServer.cast reaches its handle_cast clause by message tag', async () => {
    const b = await buildEx([
      'defmodule MyServer do',
      '  def handle_cast({:add, x}, state) do',
      '    do_work(x)',
      '    {:noreply, state}',
      '  end',
      'end',
      'defmodule Client do',
      '  def trigger(pid) do',
      '    GenServer.cast(pid, {:add, 1})',
      '  end',
      'end',
    ].join('\n'));
    const edge = edgeBetween(b, 'trigger', 'handle_cast');
    expect(edge?.confidence).toBe('synthesized');
    expect(edge?.synthesizedBy).toBe('actor-message');
  });

  it('GenServer.call reaches its handle_call clause (atom message)', async () => {
    const b = await buildEx([
      'defmodule MyServer do',
      '  def handle_call(:fetch, _from, state) do',
      '    {:reply, state, state}',
      '  end',
      'end',
      'defmodule Client do',
      '  def trigger(pid) do',
      '    GenServer.call(pid, :fetch)',
      '  end',
      'end',
    ].join('\n'));
    expect(edgeBetween(b, 'trigger', 'handle_call')?.synthesizedBy).toBe('actor-message');
  });

  it('cast does NOT pair with a same-tag handle_call', async () => {
    const b = await buildEx([
      'defmodule MyServer do',
      '  def handle_call(:fetch, _from, state) do',
      '    {:reply, state, state}',
      '  end',
      'end',
      'defmodule Client do',
      '  def trigger(pid) do',
      '    GenServer.cast(pid, :fetch)',
      '  end',
      'end',
    ].join('\n'));
    expect(edgeBetween(b, 'trigger', 'handle_call')).toBeUndefined();
    expect(synthEdges(b)).toHaveLength(0);
  });

  it('mismatched message tags produce no edge', async () => {
    const b = await buildEx([
      'defmodule MyServer do',
      '  def handle_cast({:add, x}, state) do',
      '    {:noreply, state}',
      '  end',
      'end',
      'defmodule Client do',
      '  def trigger(pid) do',
      '    GenServer.cast(pid, {:remove, 1})',
      '  end',
      'end',
    ].join('\n'));
    expect(synthEdges(b)).toHaveLength(0);
  });
});

describe('event-channel synthesis — per-language isolation', () => {
  it('does not pair a Python registration with a JS/TS dispatch on the same key', async () => {
    const b = await new CallGraphBuilder().build([
      { path: 'a.ts', content: [
        'function tsHandler() { return 1; }',
        "function tsReg(e: any) { e.on('shared', tsHandler); }",
        "function tsFire(e: any) { e.emit('shared'); }",
      ].join('\n'), language: 'TypeScript' },
      { path: 'a.py', content: [
        'def py_handler():',
        '    return 1',
        'def py_reg(e):',
        "    e.on('shared', py_handler)",
        'def py_fire(e):',
        "    e.emit('shared')",
      ].join('\n'), language: 'Python' },
    ]);
    // Within-language edges exist...
    expect(edgeBetween(b, 'tsFire', 'tsHandler')?.synthesizedBy).toBe('event-channel');
    expect(edgeBetween(b, 'py_fire', 'py_handler')?.synthesizedBy).toBe('event-channel');
    // ...but no cross-language pairing on the shared 'shared' key.
    expect(edgeBetween(b, 'tsFire', 'py_handler')).toBeUndefined();
    expect(edgeBetween(b, 'py_fire', 'tsHandler')).toBeUndefined();
  });
});

describe('route-handler synthesis (on-disk fixtures)', () => {
  let root: string;
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'ol-route-')); await mkdir(join(root, 'src'), { recursive: true }); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it('Route is wired to its handler as a synthesized calls edge', async () => {
    const file = join(root, 'src', 'server.ts');
    const content = [
      'function listUsers(req, res) { res.send([]); }',
      'function setup(app) {',
      "  app.get('/users', listUsers);",
      '}',
    ].join('\n');
    await writeFile(file, content, 'utf-8');
    const b = await new CallGraphBuilder().build([{ path: file, content, language: 'TypeScript' }]);
    const setup = idByName(b, 'setup'), handler = idByName(b, 'listUsers');
    const edge = b.edges.find(e => e.callerId === setup && e.calleeId === handler && e.confidence === 'synthesized');
    expect(edge).toBeDefined();
    expect(edge!.synthesizedBy).toBe('route-handler');
    expect(edge!.kind).toBe('calls');
  });

  // Regression (fix-route-anchor-fidelity): a comment/log preamble above the
  // route registration used to shrink the skeleton the route line was computed
  // against, so the line anchored into the ORIGINAL file landed ABOVE `setup`
  // (no enclosing function → edge silently dropped) or inside the PREVIOUS
  // function (mis-attributed). With the length-preserving mask the edge wires to
  // `setup`, not to `listUsers`'s neighbor.
  it('wires the route despite a comment/log preamble that used to drift the line', async () => {
    const file = join(root, 'src', 'server.ts');
    const content = [
      '/*',
      ' * Copyright 2026 Example Corp.',
      ' * All rights reserved.',
      ' */',
      '// Route wiring module.',
      "console.log('booting route module');",
      '',
      'function listUsers(req, res) { res.send([]); }',
      '',
      'function setup(app) {',
      "  app.get('/users', listUsers);",
      '}',
    ].join('\n');
    await writeFile(file, content, 'utf-8');
    const b = await new CallGraphBuilder().build([{ path: file, content, language: 'TypeScript' }]);
    const setup = idByName(b, 'setup'), handler = idByName(b, 'listUsers');
    const edge = b.edges.find(e => e.calleeId === handler && e.confidence === 'synthesized' && e.synthesizedBy === 'route-handler');
    expect(edge).toBeDefined();
    // Attributed to the real enclosing function, neither dropped nor mis-attributed.
    expect(edge!.callerId).toBe(setup);
  });

  // Regression (fix-artifact-output-determinism): synthesizeRouteHandlerEdges
  // aggregated per-file routes by pushing into a shared array inside Promise.all,
  // so the synthesized-edge order depended on I/O completion and the serialized
  // graph bytes were not a pure function of the input. Building the SAME multi-file
  // input twice must produce the SAME synthesized-edge order.
  it('produces a stable synthesized route-handler edge order across runs', async () => {
    const files: Array<{ path: string; content: string; language: string }> = [];
    for (const name of ['alpha', 'bravo', 'charlie', 'delta']) {
      const file = join(root, 'src', `${name}.ts`);
      const content = [
        `function ${name}Handler(req, res) { res.send('${name}'); }`,
        `function ${name}Setup(app) {`,
        `  app.get('/${name}', ${name}Handler);`,
        '}',
      ].join('\n');
      await writeFile(file, content, 'utf-8');
      files.push({ path: file, content, language: 'TypeScript' });
    }
    const synthOrder = (b: Built): string =>
      JSON.stringify(
        b.edges
          .filter(e => e.synthesizedBy === 'route-handler')
          .map(e => `${e.callerId}->${e.calleeId}`)
      );

    const runs = new Set<string>();
    for (let i = 0; i < 3; i++) {
      const b = await new CallGraphBuilder().build(files);
      runs.add(synthOrder(b));
    }
    expect(runs.size).toBe(1);
    // All four route-handler edges are present (not an empty coincidental match).
    expect(JSON.parse([...runs][0])).toHaveLength(4);
  });
});
