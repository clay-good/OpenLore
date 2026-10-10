/**
 * Expectations ledger for the Kotlin reference project
 * (change: add-kotlin-reference-corpus-conformance, issue #546).
 *
 * Every entry is one fact about `fixtures/kotlin-reference/` that follows from Kotlin language
 * rules, not from current output. An `asserted` entry must hold. A `known-gap` entry must NOT hold,
 * and it names the change that will close it; when it starts to hold, the conformance test fails
 * until the entry is promoted. So a fact cannot regress silently and a gap cannot close silently.
 */
import { KOTLIN_LANGUAGE_LEVEL } from '../kotlin-syntax-corpus.js';
import type { KotlinReferenceModel, RefNode } from './model.js';

/** The changes of `KOTLIN-TOTAL-SUPPORT-2026-10.md`. A known gap must name one of them. */
export const KOTLIN_CHANGES = [
  'add-kotlin-reference-corpus-conformance',
  'fix-kotlin-package-binding-soundness',
  'harden-kotlin-grammar-currency',
  'add-kotlin-declared-type-receivers',
  'add-kotlin-callable-node-shapes',
  'fix-kotlin-type-hierarchy-fidelity',
  'fix-kotlin-signature-and-kdoc-fidelity',
  'widen-kotlin-control-flow-overlay',
  'add-kotlin-java-interop-resolution',
  'add-kotlin-multiplatform-source-sets',
  'add-kotlin-file-dependency-and-exports',
  'add-kotlin-http-topology',
  'add-kotlin-schema-inventory',
  'add-kotlin-env-var-reads',
  'add-kotlin-ui-and-middleware-inventories',
  'add-kotlin-error-propagation',
  'add-kotlin-dynamic-boundary',
  'add-kotlin-style-fingerprint',
  'add-kotlin-public-surface',
  'add-kotlin-test-detection-and-generation',
  'add-kotlin-entry-point-roots',
  'add-kotlin-project-identity',
  'fix-kotlin-auxiliary-surface-parity',
] as const;

export type KotlinChange = (typeof KOTLIN_CHANGES)[number];

export const LEDGER_STATES = ['asserted', 'known-gap'] as const;
export type LedgerState = (typeof LEDGER_STATES)[number];

export interface LedgerEntry {
  /** Stable, unique, human-readable id. */
  id: string;
  /** The capability area the fact belongs to (documentation grouping). */
  area: string;
  /** One sentence, written as the fact that must be true. */
  fact: string;
  state: LedgerState;
  /** The change that delivers the fact. Required for a known gap. */
  change: KotlinChange;
  holds: (model: KotlinReferenceModel) => boolean | Promise<boolean>;
}

/** The ledger rule. `promote` means a known gap now holds and must become asserted. */
export function ledgerVerdict(state: string, holds: boolean): 'ok' | 'regressed' | 'promote' | 'invalid' {
  if (state === 'asserted') return holds ? 'ok' : 'regressed';
  if (state === 'known-gap') return holds ? 'promote' : 'ok';
  return 'invalid';
}

/** Deliberately out of scope for Kotlin, with the reason (from `KOTLIN-TOTAL-SUPPORT-2026-10.md`). */
export const KOTLIN_OUT_OF_SCOPE: ReadonlyArray<{ item: string; reason: string }> = [
  { item: 'Type checking, smart casts, generic substitution, overload resolution by argument type', reason: 'OpenLore reads syntax and declared types; these need a compiler front end. The affected calls are disclosed boundaries.' },
  { item: 'Compiling the project, running Gradle, reading resolved dependency graphs', reason: 'Local-first and deterministic: no build is run.' },
  { item: 'Kotlin/JS, Kotlin/Native, and Kotlin/Wasm platform APIs', reason: 'The language support is the same; platform library modeling is not in scope.' },
  { item: 'Generated code (kapt, KSP, Dagger, Room)', reason: 'It is not in the repository. Its effect is covered by annotation roots.' },
  { item: 'SQLDelight `.sq` files and Android XML layouts', reason: 'They are not Kotlin source.' },
  { item: 'The `iacProjection` capability', reason: 'It applies to infrastructure formats, not to general-purpose languages.' },
  { item: 'The `literalReflection` capability', reason: 'A Kotlin dispatch table is a map of callable references, and each reference is already an ordinary edge.' },
];

const MARK_START = '<!-- kotlin-support:start (generated from kotlin-reference/ledger.ts; do not edit by hand) -->';
const MARK_END = '<!-- kotlin-support:end -->';
export const KOTLIN_DOC_MARKERS = { start: MARK_START, end: MARK_END } as const;

/** Render the Kotlin section of `docs/language-support.md`. Deterministic: ledger order. */
export function renderKotlinSupportSection(ledger: readonly LedgerEntry[] = KOTLIN_REFERENCE_LEDGER): string {
  const row = (e: LedgerEntry): string => `| ${e.area} | ${e.fact.replaceAll('|', '\\|')} | \`${e.change}\` |`;
  const table = (entries: LedgerEntry[]): string[] => entries.length
    ? ['| Area | Fact | Change |', '|---|---|---|', ...entries.map(row)]
    : ['None.'];
  const asserted = ledger.filter(e => e.state === 'asserted');
  const gaps = ledger.filter(e => e.state === 'known-gap');
  return [
    MARK_START,
    '',
    'Each row is a fact about the Kotlin reference project (`src/core/analyzer/fixtures/kotlin-reference/`)',
    'that a test checks on every run.',
    '',
    `#### Supported (${asserted.length})`,
    '',
    ...table(asserted),
    '',
    `#### Known gaps (${gaps.length})`,
    '',
    'A known gap is checked too: the test fails when a gap closes until the row moves to "Supported".',
    '',
    ...table(gaps),
    '',
    '#### Out of scope',
    '',
    '| Not supported | Reason |',
    '|---|---|',
    ...KOTLIN_OUT_OF_SCOPE.map(o => `| ${o.item} | ${o.reason} |`),
    '',
    MARK_END,
  ].join('\n');
}

// ── Predicate helpers ───────────────────────────────────────────────────────

/**
 * Resolve a node reference. `file::Owner.name` is an exact id. `file::~name` matches the one
 * internal node of that file with that simple name, whatever its owner (used where the owner
 * spelling is itself the subject of a later change).
 */
export function findNode(model: KotlinReferenceModel, ref: string): RefNode | undefined {
  const exact = model.nodes.get(ref);
  if (exact) return exact;
  const loose = ref.match(/^(.*)::~(.+)$/);
  if (!loose) return undefined;
  const matches = [...model.nodes.values()].filter(
    n => !n.isExternal && n.filePath === loose[1] && n.name === loose[2],
  );
  return matches.length === 1 ? matches[0] : undefined;
}

const callEdges = (model: KotlinReferenceModel) => model.edges.filter(e => e.kind === 'calls');

function hasEdge(model: KotlinReferenceModel, from: string, to: string, confidence?: readonly string[]): boolean {
  const source = findNode(model, from);
  const target = findNode(model, to);
  if (!source || !target) return false;
  return callEdges(model).some(e =>
    e.from === source.id && e.to === target.id && (!confidence || confidence.includes(e.confidence)));
}

/** Confidence tiers that come from a declared type or a resolved receiver, never a bare name. */
const TYPE_DERIVED = ['type_inference', 'receiver_inferred', 'type_name', 'self_cls'] as const;

const entry = (
  id: string, area: string, state: LedgerState, change: KotlinChange, fact: string,
  holds: (model: KotlinReferenceModel) => boolean | Promise<boolean>,
): LedgerEntry => ({ id, area, fact, state, change, holds });

const edge = (
  id: string, state: LedgerState, change: KotlinChange, from: string, to: string,
  confidence?: readonly string[],
): LedgerEntry => entry(
  id, 'call graph', state, change,
  `\`${from.replace('~', '')}\` calls \`${to.replace('~', '')}\`${confidence ? ` (${confidence.join(' or ')})` : ''}`,
  m => hasEdge(m, from, to, confidence),
);

const noEdge = (
  id: string, state: LedgerState, change: KotlinChange, from: string, to: string, why: string,
): LedgerEntry => entry(
  id, 'call graph', state, change,
  `no call edge joins \`${from.replace('~', '')}\` to \`${to.replace('~', '')}\`: ${why}`,
  // An absence is only meaningful while both ends exist; a missing node must not make it "hold".
  m => !!findNode(m, from) && !!findNode(m, to) && !hasEdge(m, from, to),
);

const node = (id: string, state: LedgerState, change: KotlinChange, ref: string, what: string): LedgerEntry =>
  entry(id, 'nodes', state, change, `${what} \`${ref.replace('~', '')}\` is a graph node`, m => !!findNode(m, ref));

const capability = (id: string, state: LedgerState, change: KotlinChange, name: string): LedgerEntry =>
  entry(id, 'capabilities', state, change, `Kotlin backs the \`${name}\` capability`, m => m.capabilities.includes(name));

const external = (model: KotlinReferenceModel, name: string): boolean =>
  [...model.nodes.values()].some(n => n.isExternal && n.name === name);

const classNamed = (model: KotlinReferenceModel, name: string) => model.classes.find(c => c.name === name);

const TEST = 'service/UserServiceTest.kt::UserServiceTest';
const SERVICE = 'service/UserService.kt::UserService';
const REPO = 'repo/UserRepository.kt';
const SLUGIFY = 'util/Strings.kt::~slugify';

export const KOTLIN_REFERENCE_LEDGER: readonly LedgerEntry[] = [
  // ── Nodes that exist today ────────────────────────────────────────────────
  node('node-member-function', 'asserted', 'add-kotlin-reference-corpus-conformance', `${SERVICE}.create`, 'the member function'),
  node('node-top-level-function', 'asserted', 'add-kotlin-reference-corpus-conformance', 'repo/Stores.kt::openStore', 'the top-level function'),
  node('node-extension-function', 'asserted', 'add-kotlin-reference-corpus-conformance', SLUGIFY, 'the extension function'),
  node('node-object-member', 'asserted', 'add-kotlin-reference-corpus-conformance', 'config/Env.kt::Env.port', 'the object member'),
  node('node-interface-member', 'asserted', 'add-kotlin-reference-corpus-conformance', `${REPO}::UserRepository.save`, 'the interface member'),
  edge('edge-same-class', 'asserted', 'add-kotlin-reference-corpus-conformance', `${SERVICE}.describe`, `${SERVICE}.require`),
  edge('edge-same-file-top-level', 'asserted', 'add-kotlin-reference-corpus-conformance', 'util/Strings.kt::loadName', 'util/Strings.kt::load'),
  edge('edge-local-construction-receiver', 'asserted', 'add-kotlin-reference-corpus-conformance', 'Application.kt::~module', `${SERVICE}.create`),
  noEdge('no-edge-client-get-other-package', 'asserted', 'add-kotlin-reference-corpus-conformance',
    'client/OrderClient.kt::fetchHealth', 'web/UserController.kt::UserController.get',
    '`client.get(...)` is a Ktor client call'),

  // ── fix-kotlin-package-binding-soundness ──────────────────────────────────
  noEdge('binding-self-field-not-self', 'asserted', 'fix-kotlin-package-binding-soundness',
    'web/UserController.kt::UserController.create', 'web/UserController.kt::UserController.create',
    '`this.service.create(name)` is a call on a property, not recursion'),
  noEdge('binding-property-find-not-self', 'asserted', 'fix-kotlin-package-binding-soundness',
    `${SERVICE}.find`, `${SERVICE}.find`, '`repo.find(id)` is a call on a property, not recursion'),
  noEdge('binding-property-find-not-sibling', 'asserted', 'fix-kotlin-package-binding-soundness',
    `${SERVICE}.require`, `${SERVICE}.find`, '`repo.find(id)` has the receiver `repo`'),
  noEdge('binding-ktor-get-not-controller', 'asserted', 'fix-kotlin-package-binding-soundness',
    'Application.kt::~module', 'web/UserController.kt::UserController.get',
    '`get("/health") { }` is the Ktor routing function'),
  noEdge('binding-service-loader-not-load', 'asserted', 'fix-kotlin-package-binding-soundness',
    'plugin/Reflect.kt::startAll', 'util/Strings.kt::load',
    '`ServiceLoader.load(...)` has a receiver and `load` is private to another file'),
  noEdge('binding-start-not-plugin', 'asserted', 'fix-kotlin-package-binding-soundness',
    'Application.kt::main', 'plugin/Reflect.kt::Plugin.start',
    '`embeddedServer(...).start(...)` has a receiver of a library type'),
  noEdge('binding-audit-not-other-class', 'asserted', 'fix-kotlin-package-binding-soundness',
    `${SERVICE}.create`, `${REPO}::AuditedUserRepository.audit`,
    '`audit(...)` is a property of `UserService`; the other `audit` is a private member of another class'),
  noEdge('binding-default-import-list-of', 'asserted', 'fix-kotlin-package-binding-soundness',
    `${SERVICE}.create`, 'util/Strings.kt::listOf',
    '`listOf` is a Kotlin default import and the file does not import the project function'),
  noEdge('binding-qualified-std-not-self', 'asserted', 'fix-kotlin-package-binding-soundness',
    'util/Strings.kt::listOf', 'util/Strings.kt::listOf',
    '`kotlin.collections.listOf(...)` is fully qualified'),
  edge('binding-imported-extension', 'asserted', 'fix-kotlin-package-binding-soundness', `${SERVICE}.label`, SLUGIFY, ['import']),
  edge('binding-imported-extension-second-site', 'asserted', 'fix-kotlin-package-binding-soundness', `${SERVICE}.create`, SLUGIFY, ['import']),
  edge('binding-wildcard-import', 'asserted', 'fix-kotlin-package-binding-soundness', 'Application.kt::~module', 'repo/Stores.kt::openStore', ['import']),

  // ── add-kotlin-declared-type-receivers ────────────────────────────────────
  edge('receiver-constructor-property', 'asserted', 'add-kotlin-declared-type-receivers', `${SERVICE}.create`, `${REPO}::UserRepository.save`, TYPE_DERIVED),
  edge('receiver-constructor-property-expression-body', 'asserted', 'add-kotlin-declared-type-receivers', `${SERVICE}.find`, `${REPO}::UserRepository.find`, TYPE_DERIVED),
  edge('receiver-controller-property', 'asserted', 'add-kotlin-declared-type-receivers', 'web/UserController.kt::UserController.get', `${SERVICE}.find`, TYPE_DERIVED),
  edge('receiver-this-property-chain', 'asserted', 'add-kotlin-declared-type-receivers', 'web/UserController.kt::UserController.create', `${SERVICE}.create`, ['receiver_inferred']),
  edge('receiver-typed-parameter', 'asserted', 'add-kotlin-declared-type-receivers', 'Application.kt::warmUp', 'client/OrderClient.kt::OrderClient.fetch', TYPE_DERIVED),
  edge('receiver-delegate-property', 'asserted', 'add-kotlin-declared-type-receivers', `${REPO}::AuditedUserRepository.save`, `${REPO}::UserRepository.save`, TYPE_DERIVED),
  capability('receiver-capability', 'asserted', 'add-kotlin-declared-type-receivers', 'receiverResolution'),

  // ── add-kotlin-callable-node-shapes ───────────────────────────────────────
  node('shape-primary-constructor', 'asserted', 'add-kotlin-callable-node-shapes', `${SERVICE}.<init>`, 'the constructor'),
  edge('shape-init-block-call', 'asserted', 'add-kotlin-callable-node-shapes', `${SERVICE}.<init>`, `${SERVICE}.warm`),
  edge('shape-constructor-call', 'asserted', 'add-kotlin-callable-node-shapes', `${SERVICE}.inMemory`, `${SERVICE}.<init>`),
  edge('shape-constructor-call-top-level', 'asserted', 'add-kotlin-callable-node-shapes', 'repo/Stores.kt::openStore', `${REPO}::AuditedUserRepository.<init>`),
  edge('shape-callable-reference', 'asserted', 'add-kotlin-callable-node-shapes', `${SERVICE}.create`, `${SERVICE}.report`),
  edge('shape-infix-call', 'asserted', 'add-kotlin-callable-node-shapes', `${SERVICE}.create`, 'util/Strings.kt::~tagged'),
  node('shape-getter', 'asserted', 'add-kotlin-callable-node-shapes', `${SERVICE}.<get-summary>`, 'the property getter'),
  edge('shape-getter-call', 'asserted', 'add-kotlin-callable-node-shapes', `${SERVICE}.<get-summary>`, `${SERVICE}.render`),
  node('shape-lambda-property', 'asserted', 'add-kotlin-callable-node-shapes', `${SERVICE}.audit`, 'the function-typed property'),
  edge('shape-lambda-property-body', 'asserted', 'add-kotlin-callable-node-shapes', `${SERVICE}.audit`, `${SERVICE}.record`),
  edge('shape-lambda-property-call', 'asserted', 'add-kotlin-callable-node-shapes', `${SERVICE}.create`, `${SERVICE}.audit`),
  node('shape-top-level-initializer', 'asserted', 'add-kotlin-callable-node-shapes', 'repo/Stores.kt::<clinit>', 'the top-level property initializer'),
  node('shape-script-body', 'asserted', 'add-kotlin-callable-node-shapes', 'build.gradle.kts::<script>', 'the script body'),
  node('shape-backtick-name', 'asserted', 'add-kotlin-callable-node-shapes', `${TEST}.creates a user with a slug id`, 'the backtick-named function, stored without backticks,'),
  entry('shape-suspend-is-async', 'nodes', 'asserted', 'add-kotlin-callable-node-shapes',
    'the `suspend` function `warmUp` is marked asynchronous',
    m => findNode(m, 'Application.kt::warmUp')?.isAsync === true),

  entry('shape-synthetic-not-dead', 'dead code', 'asserted', 'add-kotlin-callable-node-shapes',
    'no constructor, initializer, or accessor node is a dead-code candidate',
    async m => (await m.deadCode()).candidates.every(id => !/<[a-z-]+[^>]*>$/.test(id))),
  entry('shape-operator-not-confidently-dead', 'dead code', 'asserted', 'add-kotlin-callable-node-shapes',
    'the operator function `Money.plus` is not reported dead with more than low confidence',
    async m => ['low', undefined].includes((await m.deadCode()).confidence['model/Money.kt::Money.plus'])),
  entry('shape-operator-no-edge', 'call graph', 'asserted', 'add-kotlin-callable-node-shapes',
    '`a + b` emits no call edge to `Money.plus`: the operator is chosen by a static type the analyzer does not compute',
    m => !!findNode(m, 'model/Money.kt::Money.plus') && !callEdges(m).some(e => e.to === 'model/Money.kt::Money.plus')),
  entry('shape-operator-boundary-count', 'boundaries', 'asserted', 'add-kotlin-dynamic-boundary',
    'the operator call `a + b` in `Money.kt` is counted as an `operator-dispatch` boundary',
    async m => (await m.operatorBoundaryFiles()).includes('model/Money.kt')),

  // ── fix-kotlin-type-hierarchy-fidelity ────────────────────────────────────
  entry('hierarchy-no-phantom-receiver-class', 'classes', 'asserted', 'fix-kotlin-type-hierarchy-fidelity',
    'the class inventory has no class named `String` (an extension receiver is not a project class)',
    m => !classNamed(m, 'String')),
  entry('hierarchy-receiver-type-field', 'classes', 'asserted', 'fix-kotlin-type-hierarchy-fidelity',
    'the extension function `slugify` records `String` as its receiver type',
    m => findNode(m, SLUGIFY)?.receiverType === 'String'),
  entry('hierarchy-interface-not-superclass', 'classes', 'asserted', 'fix-kotlin-type-hierarchy-fidelity',
    '`InMemoryUserRepository` implements the interface `UserRepository` (it is not a superclass)',
    m => {
      const c = classNamed(m, 'InMemoryUserRepository');
      return !!c?.interfaces?.includes('UserRepository') && !c.parentClasses?.includes('UserRepository');
    }),
  entry('hierarchy-delegation', 'classes', 'asserted', 'fix-kotlin-type-hierarchy-fidelity',
    '`AuditedUserRepository : UserRepository by inner` implements `UserRepository` and is marked delegating',
    m => {
      const c = classNamed(m, 'AuditedUserRepository');
      return !!c?.interfaces?.includes('UserRepository') && c.delegating === true;
    }),
  entry('hierarchy-class-kind', 'classes', 'asserted', 'fix-kotlin-type-hierarchy-fidelity',
    'class kinds are recorded: `Env` is an object, `User` a data class, `UserRepository` an interface, `Color` an enum',
    m => classNamed(m, 'Env')?.classKind === 'object' && classNamed(m, 'User')?.classKind === 'data'
      && classNamed(m, 'UserRepository')?.classKind === 'interface' && classNamed(m, 'Color')?.classKind === 'enum'),
  entry('hierarchy-override-through-delegation', 'classes', 'asserted', 'fix-kotlin-type-hierarchy-fidelity',
    '`AuditedUserRepository.save` overrides `UserRepository.save`',
    m => m.edges.some(e => e.kind === 'overrides' && e.from === `${REPO}::UserRepository.save` && e.to === `${REPO}::AuditedUserRepository.save`)),

  // ── fix-kotlin-signature-and-kdoc-fidelity ────────────────────────────────
  entry('signature-annotation-brace', 'signatures', 'asserted', 'fix-kotlin-signature-and-kdoc-fidelity',
    'the signature of `UserController.get` keeps `fun get(@PathVariable id: String): User?` after `@GetMapping("/{id}")`',
    m => (findNode(m, 'web/UserController.kt::UserController.get')?.signature ?? '').includes('fun get(@PathVariable id: String): User?')),
  entry('signature-no-expression-body', 'signatures', 'asserted', 'fix-kotlin-signature-and-kdoc-fidelity',
    'the signature of `safeDescribe` is `fun safeDescribe(id: String): String`, with no part of its expression body',
    m => findNode(m, `${SERVICE}.safeDescribe`)?.signature === 'fun safeDescribe(id: String): String'),
  entry('signature-kdoc', 'signatures', 'asserted', 'fix-kotlin-signature-and-kdoc-fidelity',
    'the KDoc of `UserController.get` is its docstring',
    m => (findNode(m, 'web/UserController.kt::UserController.get')?.docstring ?? '').includes('Returns one user by [id].')),
  entry('signature-stdlib-noise', 'call graph', 'asserted', 'fix-kotlin-signature-and-kdoc-fidelity',
    'standard-library calls (`forEach`, `runCatching`, `lowercase`, `error`) are not external leaves',
    m => !['forEach', 'runCatching', 'lowercase', 'error'].some(n => external(m, n))),

  entry('signature-no-body-anywhere', 'signatures', 'asserted', 'fix-kotlin-signature-and-kdoc-fidelity',
    'no stored signature of a Kotlin function contains a body: none has `{` outside an annotation, and none has `=` outside a parameter list',
    m => [...m.nodes.values()].filter(n => n.language === 'Kotlin' && !n.isExternal && !n.synthetic && /\bfun\b/.test(n.signature ?? ''))
      .every(n => {
        const header = (n.signature ?? '').split('\n').filter(line => !line.startsWith('@')).join(' ');
        const outsideParens = header.replace(/\([^()]*(?:\([^()]*\)[^()]*)*\)/g, '()');
        return !outsideParens.includes('{') && !outsideParens.includes('=');
      })),

  // ── widen-kotlin-control-flow-overlay ─────────────────────────────────────
  entry('cfg-when-and-try', 'control flow', 'asserted', 'widen-kotlin-control-flow-overlay',
    '`UserService.describe` has an overlay with a multi-way `when` branch, a `try` region, and an Elvis exit',
    m => {
      const cfg = m.cfgs.get(`${SERVICE}.describe`);
      const branches = (cfg?.blocks ?? []).filter(b => b.kind === 'branch').length;
      // Elvis (`id ?: return`), `try`, and `when` are three separate branch points.
      return branches >= 3;
    }),
  entry('cfg-expression-body', 'control flow', 'asserted', 'widen-kotlin-control-flow-overlay',
    '`UserService.require` (an expression body with an Elvis `throw`) has an overlay with a branch',
    m => (m.cfgs.get(`${SERVICE}.require`)?.blocks ?? []).some(b => b.kind === 'branch')),

  // ── add-kotlin-java-interop-resolution ────────────────────────────────────
  edge('interop-file-facade', 'asserted', 'add-kotlin-java-interop-resolution', 'legacy/LegacyCaller.java::LegacyCaller.store', 'repo/Stores.kt::openStore', ['import']),
  edge('interop-object-instance', 'asserted', 'add-kotlin-java-interop-resolution', 'legacy/LegacyCaller.java::LegacyCaller.port', 'config/Env.kt::Env.port', ['import']),
  edge('interop-companion', 'asserted', 'add-kotlin-java-interop-resolution', 'legacy/LegacyCaller.java::LegacyCaller.service', `${SERVICE}.inMemory`, ['import']),

  // ── add-kotlin-multiplatform-source-sets ──────────────────────────────────
  entry('kmp-actualizes', 'multiplatform', 'asserted', 'add-kotlin-multiplatform-source-sets',
    'the `actual fun platformName` is joined to its `expect` declaration by an `actualizes` relation',
    m => m.edges.some(e => e.kind === 'actualizes' && e.from === 'platform/Platform.kt::platformName' && e.to === 'platform/Platform.jvm.kt::platformName')),
  entry('kmp-expect-is-the-binding-target', 'multiplatform', 'asserted', 'add-kotlin-multiplatform-source-sets',
    '`banner` calls the `expect fun platformName`, and the `actual` in `jvmMain` does not make the name ambiguous',
    m => hasEdge(m, 'platform/Platform.kt::banner', 'platform/Platform.kt::platformName')),
  entry('kmp-actual-not-dead', 'multiplatform', 'asserted', 'add-kotlin-multiplatform-source-sets',
    'the `actual fun platformName` is a dead-code candidate only together with its `expect` declaration',
    async m => {
      const dead = (await m.deadCode()).candidates;
      return dead.includes('platform/Platform.jvm.kt::platformName') === dead.includes('platform/Platform.kt::platformName')
        && m.edges.some(e => e.kind === 'actualizes');
    }),
  entry('kmp-source-set', 'multiplatform', 'asserted', 'add-kotlin-multiplatform-source-sets',
    'nodes record their source set (`commonMain`, `jvmMain`)',
    m => findNode(m, 'platform/Platform.kt::banner')?.sourceSet === 'commonMain'
      && findNode(m, 'platform/Platform.jvm.kt::platformName')?.sourceSet === 'jvmMain'),

  // ── add-kotlin-file-dependency-and-exports ────────────────────────────────
  entry('files-import-edge', 'file graph', 'asserted', 'add-kotlin-file-dependency-and-exports',
    '`UserService.kt` has an import edge to `UserRepository.kt` (`import com.acme.repo.UserRepository`)',
    m => m.importEdges.some(e => e.from === 'service/UserService.kt' && e.to === 'repo/UserRepository.kt')),
  entry('files-import-top-level-function', 'file graph', 'asserted', 'add-kotlin-file-dependency-and-exports',
    '`UserService.kt` has an import edge to `Strings.kt` (`import com.acme.util.slugify`)',
    m => m.importEdges.some(e => e.from === 'service/UserService.kt' && e.to === 'util/Strings.kt')),
  entry('files-wildcard-import', 'file graph', 'asserted', 'add-kotlin-file-dependency-and-exports',
    '`Application.kt` has an import edge to `Stores.kt` through `import com.acme.repo.*` (it uses `openStore`)',
    m => m.importEdges.some(e => e.from === 'Application.kt' && e.to === 'repo/Stores.kt')),
  entry('files-java-imports-kotlin', 'file graph', 'asserted', 'add-kotlin-file-dependency-and-exports',
    '`LegacyCaller.java` has an import edge to `UserService.kt`',
    m => m.importEdges.some(e => e.from === 'legacy/LegacyCaller.java' && e.to === 'service/UserService.kt')),
  entry('files-exports-visibility', 'file graph', 'asserted', 'add-kotlin-file-dependency-and-exports',
    '`Strings.kt` exports `slugify`, `loadName`, and `Color`, and does not export the private `load`',
    m => {
      const exported = m.exportsByFile.get('util/Strings.kt') ?? [];
      return ['slugify', 'loadName', 'Color'].every(n => exported.includes(n)) && !exported.includes('load');
    }),

  // ── add-kotlin-http-topology ──────────────────────────────────────────────
  entry('http-spring-routes', 'routes', 'asserted', 'add-kotlin-http-topology',
    'Spring routes `GET /api/users/{id}` and `POST /api/users` are listed',
    m => hasRoute(m, 'GET', '/api/users/{id}') && hasRoute(m, 'POST', '/api/users')),
  entry('http-ktor-routes', 'routes', 'asserted', 'add-kotlin-http-topology',
    'Ktor routes `GET /health`, `POST /users`, and `GET /users/{id}` are listed',
    m => hasRoute(m, 'GET', '/health') && hasRoute(m, 'POST', '/users') && hasRoute(m, 'GET', '/users/{id}')),
  capability('http-capability', 'asserted', 'add-kotlin-http-topology', 'crossServiceHttp'),

  // ── add-kotlin-schema-inventory ───────────────────────────────────────────
  entry('schema-jpa-entity', 'schemas', 'asserted', 'add-kotlin-schema-inventory',
    'the JPA entity `User` is listed as table `users` with columns `id` and `display_name`',
    m => m.schemas.some(s => s.name === 'users' && s.fields.includes('id') && s.fields.includes('display_name'))),
  entry('schema-exposed-table', 'schemas', 'asserted', 'add-kotlin-schema-inventory',
    'the Exposed table `orders` is listed with columns `id`, `user_id`, and `total`',
    m => m.schemas.some(s => s.name === 'orders' && ['id', 'user_id', 'total'].every(f => s.fields.includes(f)))),

  // ── add-kotlin-env-var-reads ──────────────────────────────────────────────
  entry('env-optional-read', 'environment', 'asserted', 'add-kotlin-env-var-reads',
    '`ACME_PORT` is listed as an optional read (`System.getenv("ACME_PORT") ?: "8080"`)',
    m => m.envVars.some(v => v.name === 'ACME_PORT' && v.required === false)),
  entry('env-required-read', 'environment', 'asserted', 'add-kotlin-env-var-reads',
    '`ACME_DATABASE_URL` (`?: error(...)`) and `ACME_TOKEN` (`getValue`) are listed as required reads',
    m => ['ACME_DATABASE_URL', 'ACME_TOKEN'].every(n => m.envVars.some(v => v.name === n && v.required === true))),
  entry('env-gradle-provider', 'environment', 'asserted', 'add-kotlin-env-var-reads',
    '`ACME_REGION` is listed from `providers.environmentVariable("ACME_REGION")` in the build script',
    m => m.envVars.some(v => v.name === 'ACME_REGION')),

  entry('env-impact-read-site', 'environment', 'asserted', 'add-kotlin-env-var-reads',
    '`analyze_env_impact` for `ACME_PORT` names the read in `Env.port` and the caller `main`',
    async m => {
      const impact = await m.envImpact('ACME_PORT');
      const text = JSON.stringify(impact);
      return /"enclosingFunction":"[^"]*port/.test(text) && /"symbol":"[^"]*main/.test(text) && text.includes('OUT OF SCOPE');
    }),

  // ── add-kotlin-ui-and-middleware-inventories ──────────────────────────────
  entry('ui-compose-components', 'inventories', 'asserted', 'add-kotlin-ui-and-middleware-inventories',
    'the `@Composable` functions `Greeting` and `GreetingList` are listed as UI components',
    m => ['Greeting', 'GreetingList'].every(n => m.uiComponents.some(c => c.name === n))),
  entry('middleware-ktor-install', 'inventories', 'asserted', 'add-kotlin-ui-and-middleware-inventories',
    'the Ktor plugin installation `install(CallLogging)` is listed as middleware',
    m => m.middleware.some(x => x.name === 'CallLogging')),

  // ── Capabilities delivered by the conclusion changes ──────────────────────
  capability('errors-capability', 'asserted', 'add-kotlin-error-propagation', 'errorPropagation'),
  entry('errors-elvis-throw-escapes', 'error propagation', 'asserted', 'add-kotlin-error-propagation',
    '`UserNotFound` escapes `UserService.require` (`repo.find(id) ?: throw UserNotFound(id)`)',
    async m => {
      const result = await m.errorPropagation('require::src/main/kotlin/com/acme/service/UserService.kt');
      return (result.escapes as Array<{ type: string }> | undefined ?? []).some(e => e.type === 'UserNotFound');
    }),
  entry('errors-typed-catch-handles', 'error propagation', 'asserted', 'add-kotlin-error-propagation',
    '`UserService.describe` handles `UserNotFound` in its `catch (e: UserNotFound)` and lets nothing escape',
    async m => {
      const result = await m.errorPropagation('describe::src/main/kotlin/com/acme/service/UserService.kt');
      const escapes = result.escapes as Array<{ type: string }> | undefined ?? [];
      const handled = result.handledInternally as Array<{ type: string }> | undefined ?? [];
      return escapes.length === 0 && handled.some(h => h.type === 'UserNotFound');
    }),
  entry('errors-run-catching-handles', 'error propagation', 'asserted', 'add-kotlin-error-propagation',
    '`UserService.safeDescribe` handles everything thrown inside `runCatching { }`',
    async m => {
      const result = await m.errorPropagation('safeDescribe::src/main/kotlin/com/acme/service/UserService.kt');
      return (result.escapes as unknown[] | undefined ?? []).length === 0
        && (result.handledInternally as Array<{ type: string }> | undefined ?? []).some(h => h.type === 'UserNotFound');
    }),
  entry('errors-contract-call', 'error propagation', 'asserted', 'add-kotlin-error-propagation',
    '`IllegalStateException` escapes `Env.databaseUrl` (`?: error("…")` is a standard-library contract call)',
    async m => {
      const result = await m.errorPropagation('databaseUrl::src/main/kotlin/com/acme/config/Env.kt');
      return (result.escapes as Array<{ type: string }> | undefined ?? []).some(e => e.type === 'IllegalStateException');
    }),
  capability('dynamic-capability', 'asserted', 'add-kotlin-dynamic-boundary', 'dynamicBoundary'),
  entry('dynamic-reflection-sites', 'boundaries', 'asserted', 'add-kotlin-dynamic-boundary',
    '`plugin/Reflect.kt` records a `dynamic-import` site (`ServiceLoader.load`, `Class.forName`) and a `reflective-invoke` site (`memberFunctions`, `call`, `newInstance`)',
    async m => {
      const sites = await m.dynamicSites();
      return sites.includes('plugin/Reflect.kt::dynamic-import') && sites.includes('plugin/Reflect.kt::reflective-invoke');
    }),
  entry('dynamic-no-ordinary-sites', 'boundaries', 'asserted', 'add-kotlin-dynamic-boundary',
    'no other file of the reference project records a dynamic-boundary site',
    async m => (await m.dynamicSites()).every(site => site.startsWith('plugin/Reflect.kt::'))),
  entry('dynamic-dead-code-qualified', 'dead code', 'asserted', 'add-kotlin-dynamic-boundary',
    'no dead-code candidate in `plugin/Reflect.kt` is reported with more than low confidence',
    async m => Object.entries((await m.deadCode()).confidence)
      .filter(([id]) => id.startsWith('plugin/Reflect.kt::')).every(([, confidence]) => confidence === 'low')),
  capability('style-capability', 'asserted', 'add-kotlin-style-fingerprint', 'styleFingerprint'),
  entry('style-repository-profile', 'style', 'asserted', 'add-kotlin-style-fingerprint',
    'the repository style fingerprint has a Kotlin profile whose `binding` idiom is measured (`val` dominant) and which reports no `asyncForm`',
    async m => {
      const result = await m.styleFingerprint();
      const kotlin = (result.byLanguage as Array<{ language: string; idioms: Record<string, { dominant?: string }> }> | undefined ?? [])
        .find(p => p.language === 'Kotlin');
      return kotlin?.idioms.binding?.dominant === 'val' && !('asyncForm' in kotlin.idioms);
    }),
  entry('style-file-profile', 'style', 'asserted', 'add-kotlin-style-fingerprint',
    'a file-scope fingerprint is returned for `service/UserService.kt`, and none for `build.gradle.kts`',
    async m => {
      const file = await m.styleFingerprint({ filePath: 'service/UserService.kt' });
      const build = await m.styleFingerprint({ filePath: 'build.gradle.kts' });
      return file.scope === 'file' && typeof build.error === 'string';
    }),
  entry('style-region-profile', 'style', 'asserted', 'add-kotlin-style-fingerprint',
    'every region of the style fingerprint that holds a Kotlin file has a Kotlin profile',
    async m => {
      const repo = await m.styleFingerprint();
      if (typeof repo.regionCount !== 'number' || repo.regionCount === 0) return false;
      const raw = m.raw.styleFingerprint as { regions?: Array<{ communityId: string; byLanguage: Array<{ language: string }> }> } | undefined;
      const regions = raw?.regions ?? [];
      if (regions.length === 0) return false;
      const first = await m.styleFingerprint({ communityId: regions[0].communityId });
      return first.scope === 'region' && regions.every(r => r.byLanguage.some(p => p.language === 'Kotlin'));
    }),

  // ── add-kotlin-public-surface ─────────────────────────────────────────────
  entry('surface-membership', 'public surface', 'known-gap', 'add-kotlin-public-surface',
    'the public surface lists `openStore` and `UserService`, and does not list the private `load`',
    async m => {
      const names = await m.publicSurfaceNames();
      return names.includes('openStore') && names.includes('UserService') && !names.includes('load');
    }),

  // ── add-kotlin-test-detection-and-generation ──────────────────────────────
  entry('tests-kotest-nodes', 'tests', 'known-gap', 'add-kotlin-test-detection-and-generation',
    'the Kotest spec `UserServiceSpec` has a test node for "safeDescribe falls back" that reaches `UserService.safeDescribe`',
    m => m.edges.some(e => e.to === `${SERVICE}.safeDescribe` && m.nodes.get(e.from)?.isTest === true
      && e.from.startsWith('service/UserServiceSpec.kt::') && (m.nodes.get(e.from)?.name ?? '').includes('safeDescribe falls back'))),
  // `service` is a class property initialized by a constructor call.
  edge('tests-junit-reaches-service', 'asserted', 'add-kotlin-declared-type-receivers', `${TEST}.describesMissingUser`, `${SERVICE}.describe`, TYPE_DERIVED),

  // ── add-kotlin-entry-point-roots ──────────────────────────────────────────
  entry('roots-gradle-main-class', 'entry points', 'known-gap', 'add-kotlin-entry-point-roots',
    '`main` in `Application.kt` is a root named by `application { mainClass.set("com.acme.ApplicationKt") }`',
    async m => (await m.deadCode()).wiredFiles.includes('Application.kt')),
  entry('roots-spring-handler', 'entry points', 'known-gap', 'add-kotlin-entry-point-roots',
    'the Spring handler `UserController.get` is a framework root, not a dead-code candidate',
    async m => {
      const dead = await m.deadCode();
      return !dead.candidates.includes('web/UserController.kt::UserController.get') && (dead.rootKinds.httpHandlers ?? 0) > 0;
    }),

  // ── add-kotlin-project-identity ───────────────────────────────────────────
  entry('identity-project-type', 'identity', 'known-gap', 'add-kotlin-project-identity',
    'the project type is Kotlin', m => m.projectType.toLowerCase() === 'kotlin'),
  entry('identity-frameworks', 'identity', 'known-gap', 'add-kotlin-project-identity',
    'Spring Boot and Ktor are detected as frameworks',
    m => m.frameworks.some(f => /spring/i.test(f)) && m.frameworks.some(f => /ktor/i.test(f))),
  entry('identity-package-named-android', 'identity', 'known-gap', 'add-kotlin-project-identity',
    'a source package directory named `android` is analyzed, not skipped as build output',
    m => !!findNode(m, 'android/Widget.kt::Widget.key')),
  entry('identity-build-script-not-a-domain', 'identity', 'known-gap', 'add-kotlin-project-identity',
    'the Gradle build script is not a domain', m => !m.domains.includes('build-gradle')),

  // ── fix-kotlin-auxiliary-surface-parity ───────────────────────────────────
  entry('parity-ast-chunking', 'search', 'known-gap', 'fix-kotlin-auxiliary-surface-parity',
    'search chunking splits a Kotlin file at declaration boundaries',
    async () => {
      const { AST_CHUNK_LANGUAGES } = await import('../ast-chunker.js') as { AST_CHUNK_LANGUAGES?: ReadonlySet<string> };
      return AST_CHUNK_LANGUAGES?.has('Kotlin') === true;
    }),

  // ── harden-kotlin-grammar-currency ────────────────────────────────────────
  entry('grammar-corpus-clean', 'grammar', 'asserted', 'harden-kotlin-grammar-currency',
    'every source file of the reference project parses without a syntax error, at a declared language level',
    m => m.parseErrorFiles.length === 0 && /^\d+\.\d+$/.test(KOTLIN_LANGUAGE_LEVEL)),
];

function hasRoute(model: KotlinReferenceModel, method: string, path: string): boolean {
  return model.routes.some(r => r.method === method && r.path === path);
}
