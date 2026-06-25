# Spec — Enrichissement du call graph (tous langages)

> **Status (verified 2026-06-09): IMPLEMENTED.** The 8-phase call-graph enrichment shipped in commit
> `9db1d5e` ("feat(call-graph): implement 8-phase call graph enrichment"). The per-language diagnostic
> table below reflects the pre-enrichment baseline; treat it as historical context, not pending work.

**Date :** 2026-03-15
**Priorité :** Python > C++ > TypeScript > Go > Rust > Java > Ruby
**Principe :** 3 composants transversaux (Phases 1–3) bénéficient à tous les langages. Les Phases 4–5 sont par langage.

---

## Décision d'architecture

**Réécriture native TypeScript** — pas de subprocess Python ni de sidecar. openlore charge déjà tree-sitter en Node.js — les mêmes grammaires AST sont disponibles in-process. Les fichiers Python de code-graph-rag servent uniquement de spécification de référence pendant l'implémentation.

---

## Diagnostic par langage — état actuel

| Langage | Receiver capturé | Import résolu dans résolution | Inférence de type |
|---------|-----------------|-------------------------------|-------------------|
| Python | ✅ capturé, **filtré** à `self`/`cls` | ✗ | ✗ |
| C++ | ✗ champ `field` seulement | ✗ (`#include` non traité) | ✗ |
| TypeScript | ✗ `property` seulement | ✗ (parsé mais non utilisé) | ✗ |
| Go | ✗ `field` seulement | ✗ | ✗ |
| Rust | ✗ `field` seulement | ✗ | ✗ |
| Java | ✗ nom seulement | ✗ | ✗ |
| Ruby | ✗ nom seulement | ✗ | ✗ |

---

## Vue d'ensemble des fichiers

```
src/core/analyzer/
  call-graph.ts                  ← MODIFIER (6 points d'intégration)
  function-registry-trie.ts      ← CRÉER (Phase 1)
  import-resolver-bridge.ts      ← CRÉER (Phase 3)
  call-resolver.ts               ← CRÉER (Phase 6 — intégration build())
  type-inference-engine.ts       ← CRÉER (Phase 4)
  cpp-header-resolver.ts         ← CRÉER (Phase 5 — spécifique C++)
  function-registry-trie.test.ts ← CRÉER
  type-inference-engine.test.ts  ← CRÉER
```

---

## Phase 1 — `FunctionRegistryTrie`

**Problème résolu :** La résolution actuelle (lignes 1246–1265 de `call-graph.ts`) utilise un `Map<string, FunctionNode[]>` plat. Quand plusieurs fonctions s'appellent `process` ou `handle`, la résolution prend la première ou préfère le même fichier — sans considérer la classe ou le qualifiedName.

### Créer `src/core/analyzer/function-registry-trie.ts`

```typescript
import type { FunctionNode } from './call-graph.js';

export class FunctionRegistryTrie {
  private byName = new Map<string, FunctionNode[]>();
  private byQualified = new Map<string, FunctionNode[]>();
  private byId = new Map<string, FunctionNode>();

  insert(node: FunctionNode): void {
    this.byId.set(node.id, node);

    const byName = this.byName.get(node.name) ?? [];
    byName.push(node);
    this.byName.set(node.name, byName);

    if (node.className) {
      const key = `${node.className}.${node.name}`;
      const byQ = this.byQualified.get(key) ?? [];
      byQ.push(node);
      this.byQualified.set(key, byQ);
    }
  }

  findBySimpleName(name: string): FunctionNode[] {
    return this.byName.get(name) ?? [];
  }

  findByQualifiedName(className: string, methodName: string): FunctionNode[] {
    return this.byQualified.get(`${className}.${methodName}`) ?? [];
  }

  findById(id: string): FunctionNode | undefined {
    return this.byId.get(id);
  }

  allNodes(): FunctionNode[] {
    return Array.from(this.byId.values());
  }
}
```

### Créer `src/core/analyzer/function-registry-trie.test.ts`

```typescript
import { describe, it, expect } from 'vitest';
import { FunctionRegistryTrie } from './function-registry-trie.js';
import type { FunctionNode } from './call-graph.js';

function makeNode(overrides: Partial<FunctionNode> & { name: string; filePath: string }): FunctionNode {
  return {
    id: overrides.className
      ? `${overrides.filePath}::${overrides.className}.${overrides.name}`
      : `${overrides.filePath}::${overrides.name}`,
    isAsync: false, language: 'Python',
    startIndex: 0, endIndex: 100,
    fanIn: 0, fanOut: 0,
    ...overrides,
  };
}

describe('FunctionRegistryTrie', () => {
  it('retrouve par nom simple', () => {
    const trie = new FunctionRegistryTrie();
    const node = makeNode({ name: 'process', filePath: 'a.py' });
    trie.insert(node);
    expect(trie.findBySimpleName('process')).toHaveLength(1);
    expect(trie.findBySimpleName('missing')).toHaveLength(0);
  });

  it('retrouve par nom qualifié', () => {
    const trie = new FunctionRegistryTrie();
    trie.insert(makeNode({ name: 'handle', className: 'Handler', filePath: 'h.py' }));
    trie.insert(makeNode({ name: 'handle', className: 'OtherHandler', filePath: 'o.py' }));
    expect(trie.findByQualifiedName('Handler', 'handle')).toHaveLength(1);
    expect(trie.findByQualifiedName('Handler', 'handle')[0].filePath).toBe('h.py');
  });

  it('retrouve par ID complet', () => {
    const trie = new FunctionRegistryTrie();
    const node = makeNode({ name: 'run', filePath: 'main.py' });
    trie.insert(node);
    expect(trie.findById(node.id)).toBe(node);
  });
});
```

### Modifier `call-graph.ts` — Point A (lignes 1246–1251)

Ajouter l'import en tête de fichier :
```typescript
import { FunctionRegistryTrie } from './function-registry-trie.js';
```

Remplacer :
```typescript
const nodesByName = new Map<string, FunctionNode[]>();
for (const node of allNodes.values()) {
  const list = nodesByName.get(node.name) ?? [];
  list.push(node);
  nodesByName.set(node.name, list);
}
```
Par :
```typescript
const trie = new FunctionRegistryTrie();
for (const node of allNodes.values()) {
  trie.insert(node);
}
```

Remplacer la résolution (lignes 1255–1265) :
```typescript
const candidates = nodesByName.get(raw.calleeName);
```
Par :
```typescript
const candidates = trie.findBySimpleName(raw.calleeName);
```

**Validation :** `npm run test:run` — zéro régression.

---

## Phase 2 — Capturer le receiver dans tous les extracteurs

C'est la modification centrale qui débloque les Phases 3 et 4.

### 2.1 — Étendre `RawEdge` et ajouter `EdgeConfidence` dans `call-graph.ts`

Ajouter avant la classe `CallGraphBuilder` :
```typescript
interface RawEdge {
  callerId: string;
  calleeName: string;
  line: number;
  calleeObject?: string;  // "svc" dans svc.process(), "self" dans self.run()
}

/** Niveau de confiance d'un edge résolu — ordre décroissant de certitude. */
export type EdgeConfidence =
  | 'self_cls'        // self.foo() / cls.foo() — intra-classe, sans ambiguïté
  | 'type_inference'  // svc.foo() + svc: MyClass inféré dans le même corps de fonction
  | 'import'          // nom importé explicitement, fichier source connu
  | 're_export'       // résolu à travers une chaîne de ré-exports (barrel) jusqu'à la vraie définition
  | 'http_endpoint'   // appel HTTP résolu vers un handler cross-langage
  | 'same_file'       // seul candidat dans le même fichier
  | 'type_name'       // récepteur capitalisé traité comme nom de type (Swift/C++/Java statique)
  | 'name_only'       // nom unique dans tout le projet, sans autre contexte
  | 'synthesized'     // edge de dispatch dynamique reconstruit par synthèse AST (CHA, route, etc.)
  | 'external';       // appel externe/stdlib non résolu (nœud feuille synthétique)
```

> **Ré-exports / barrels (`re_export`).** Le résolveur d'imports suit les chaînes
> `export { x } from './impl'` / `export * from './x'` (et les spécificateurs ESM `.js` de
> TypeScript) à travers n'importe quelle profondeur de barrel jusqu'à la vraie définition du symbole,
> avec détection de cycle et borne de profondeur. Une arête résolue à travers un saut de ré-export
> porte la confiance `re_export` (cible prouvée, coût de distance 1 comme un import direct, mais le
> saut de barrel est divulgué) ; un import direct reste `import`. La carte d'imports est désormais
> appliquée à la résolution des arêtes d'appel (Pass 2), pas seulement aux classes de base — donc un
> appel inter-fichiers se résout précisément au lieu de retomber sur `name_only`. Voir
> `openspec/changes/add-call-resolution-recall/`.

Étendre `CallEdge` pour inclure la confiance :
```typescript
interface CallEdge {
  callerId: string;
  calleeId: string;
  calleeName: string;
  line: number;
  confidence: EdgeConfidence;
}
```

Mettre à jour toutes les signatures de fonctions d'extraction (7 fonctions) pour retourner `RawEdge[]`.

### 2.2 — Python : lever le filtre `self`/`cls` (lignes 679–703)

```typescript
// AVANT
if (objectName !== 'self' && objectName !== 'cls') continue;
rawEdges.push({ callerId: caller.id, calleeName, line: ... });

// APRÈS
rawEdges.push({
  callerId: caller.id,
  calleeName,
  calleeObject: objectName,
  line: nodeCapture.node.startPosition.row + 1,
});
```

### 2.3 — TypeScript : étendre `TS_CALL_QUERY`

Ajouter un pattern avec capture du receiver :
```
(call_expression
  function: (member_expression
    object: (identifier) @call.object
    property: (property_identifier) @call.name)) @call.node
```

Dans la boucle d'extraction :
```typescript
const objectCapture = match.captures.find(c => c.name === 'call.object');
rawEdges.push({ callerId: caller.id, calleeName,
                calleeObject: objectCapture?.node.text, line: ... });
```

### 2.4 — Go : étendre `GO_CALL_QUERY`

Ajouter :
```
(call_expression
  function: (selector_expression
    operand: (identifier) @call.object
    field: (field_identifier) @call.name)) @call.node
```

### 2.5 — Rust : étendre `RUST_CALL_QUERY`

Ajouter :
```
(call_expression
  function: (field_expression
    value: (identifier) @call.object
    field: (field_identifier) @call.name)) @call.node
```

### 2.6 — Ruby : étendre `RUBY_CALL_QUERY`

Ajouter :
```
(call
  receiver: (identifier) @call.object
  method: (identifier) @call.name) @call.node
```

### 2.7 — Java : étendre `JAVA_CALL_QUERY`

Ajouter :
```
(method_invocation
  object: (identifier) @call.object
  name: (identifier) @call.name) @call.node
```

### 2.8 — C++ : étendre `CPP_CALL_QUERY` (lignes 1102–1109)

Ajouter :
```
(call_expression
  function: (field_expression
    argument: (identifier) @call.object
    field: (field_identifier) @call.name)) @call.node

(call_expression
  function: (field_expression
    argument: (pointer_expression (identifier) @call.object)
    field: (field_identifier) @call.name)) @call.node
```

**Validation Phase 2 :** `npm run test:run` — zéro régression.

---

## Phase 3 — `ImportResolverBridge` *(transversal, adapté par langage)*

Créer `src/core/analyzer/import-resolver-bridge.ts`.

### Structure commune

```typescript
import type { FileAnalysis } from './import-parser.js';
import { dirname, resolve } from 'node:path';

/** filePath → Map<localName, sourceFilePath résolu> */
export type ImportMap = Map<string, Map<string, string>>;

export function buildImportMap(analyses: FileAnalysis[]): ImportMap {
  const map: ImportMap = new Map();
  for (const analysis of analyses) {
    const fileMap = new Map<string, string>();
    const dir = dirname(analysis.filePath);
    for (const imp of analysis.imports) {
      if (!imp.isRelative) continue;
      const resolvedSource = resolve(dir, imp.source);
      for (const name of imp.importedNames) {
        fileMap.set(name, resolvedSource);
      }
    }
    if (fileMap.size > 0) map.set(analysis.filePath, fileMap);
  }
  return map;
}

export function findCalleeFileViaImport(
  importMap: ImportMap,
  callerFilePath: string,
  calleeName: string
): string | undefined {
  return importMap.get(callerFilePath)?.get(calleeName);
}
```

### Parsers spécifiques (Go, Rust, Ruby, Java)

```typescript
export function parseGoImports(
  filePath: string, content: string, allFilePaths: string[]
): Map<string, string> {
  const result = new Map<string, string>();
  const dir = dirname(filePath);
  // import "path/to/pkg" ou import alias "path/to/pkg"
  for (const m of content.matchAll(/import\s+(?:(\w+)\s+)?"([^"]+)"/g)) {
    const importPath = m[2];
    if (!importPath.startsWith('.')) continue;
    const resolved = resolve(dir, importPath);
    const match = allFilePaths.find(f => f.startsWith(resolved));
    if (match) result.set(m[1] ?? importPath.split('/').pop()!, resolved);
  }
  // import groupé
  for (const group of content.matchAll(/import\s+\(\s*([\s\S]*?)\s*\)/g)) {
    for (const line of group[1].split('\n')) {
      const m = line.trim().match(/^(?:(\w+)\s+)?"([^"]+)"/);
      if (!m || !m[2].startsWith('.')) continue;
      const resolved = resolve(dir, m[2]);
      result.set(m[1] ?? m[2].split('/').pop()!, resolved);
    }
  }
  return result;
}

export function parseRustImports(
  filePath: string, content: string, allFilePaths: string[]
): Map<string, string> {
  const result = new Map<string, string>();
  for (const m of content.matchAll(/use\s+((?:crate|super|self)(?:::\w+)+);/g)) {
    const parts = m[1].split('::');
    const typeName = parts[parts.length - 1];
    const modulePath = parts.slice(1, -1).join('/');
    const candidate = allFilePaths.find(f =>
      f.endsWith(`/${modulePath}.rs`) || f.endsWith(`/${modulePath}/mod.rs`)
    );
    if (candidate) result.set(typeName, candidate);
  }
  return result;
}

export function parseRubyImports(
  filePath: string, content: string, allFilePaths: string[]
): Map<string, string> {
  const result = new Map<string, string>();
  const dir = dirname(filePath);
  for (const m of content.matchAll(/require_relative\s+['"]([^'"]+)['"]/g)) {
    const resolved = resolve(dir, m[1]);
    const candidate = allFilePaths.find(f => f === resolved || f === resolved + '.rb');
    if (candidate) result.set(m[1].split('/').pop()!.replace(/\.rb$/, ''), candidate);
  }
  return result;
}

export function parseJavaImports(
  content: string, allFilePaths: string[]
): Map<string, string> {
  const result = new Map<string, string>();
  for (const m of content.matchAll(/^import\s+(?:static\s+)?[\w.]+\.(\w+);/gm)) {
    const candidate = allFilePaths.find(f => f.endsWith(`/${m[1]}.java`));
    if (candidate) result.set(m[1], candidate);
  }
  return result;
}
```

### Modifier la signature de `build()` dans `call-graph.ts`

```typescript
async build(
  files: Array<{ path: string; content: string; language: string }>,
  layers?: Record<string, string[]>,
  importMap?: ImportMap
): Promise<CallGraphResult>
```

### Brancher dans `artifact-generator.ts`

```typescript
import { ImportExportParser } from './import-parser.js';
import { buildImportMap, parseGoImports, parseRustImports,
         parseRubyImports, parseJavaImports } from './import-resolver-bridge.js';

const importParser = new ImportExportParser();
const tsAnalyses = await importParser.parseFiles(
  files.filter(f => ['TypeScript','JavaScript','Python'].includes(f.language)).map(f => f.path)
);
const importMap = buildImportMap(tsAnalyses);
const allFilePaths = files.map(f => f.path);
for (const file of files) {
  let langMap: Map<string, string> | undefined;
  if (file.language === 'Go')   langMap = parseGoImports(file.path, file.content, allFilePaths);
  if (file.language === 'Rust') langMap = parseRustImports(file.path, file.content, allFilePaths);
  if (file.language === 'Ruby') langMap = parseRubyImports(file.path, file.content, allFilePaths);
  if (file.language === 'Java') langMap = parseJavaImports(file.content, allFilePaths);
  if (langMap?.size) importMap.set(file.path, langMap);
}
const callGraph = await callGraphBuilder.build(files, layers, importMap);
```

---

## Phase 4 — `TypeInferenceEngine` *(par langage)*

Créer `src/core/analyzer/type-inference-engine.ts`.

### Granularité : corps de fonction, pas fichier entier

**Problème (ChatGPT) :** Si on passe le fichier entier à `inferTypesFromSource`, une variable locale `svc` d'une fonction peut polluer la résolution dans une autre fonction du même fichier qui a aussi un `svc` d'un autre type.

**Solution :** indexer les types inférés par `functionId` (= `callerId` dans `RawEdge`), en passant uniquement le corps de la fonction via `node.startIndex` / `node.endIndex`.

Dans Phase 6, `inferredTypesByFile` devient `inferredTypesByFunction` :
```typescript
// AVANT
const inferredTypesByFile = new Map<string, InferredTypes>();
for (const file of files) {
  inferredTypesByFile.set(file.path, inferTypesFromSource(file.content, file.language));
}
// usage : inferredTypesByFile.get(callerNode.filePath)

// APRÈS
const fileContents = new Map(files.map(f => [f.path, f.content]));
const inferredTypesByFunction = new Map<string, InferredTypes>();
for (const [nodeId, node] of allNodes) {
  const body = (fileContents.get(node.filePath) ?? '').slice(node.startIndex, node.endIndex);
  inferredTypesByFunction.set(nodeId, inferTypesFromSource(body, node.language));
}
// usage : inferredTypesByFunction.get(raw.callerId)
```

L'API de `inferTypesFromSource` ne change pas — seul le texte passé est plus court.

### Interface commune

```typescript
export type InferredTypes = Map<string, string>;  // varName → className

export function inferTypesFromSource(source: string, language: string): InferredTypes {
  switch (language) {
    case 'Python':     return inferPython(source);
    case 'C++':        return inferCpp(source);
    case 'TypeScript':
    case 'JavaScript': return inferTypeScript(source);
    case 'Go':         return inferGo(source);
    case 'Rust':       return inferRust(source);
    case 'Java':       return inferJava(source);
    case 'Ruby':       return inferRuby(source);
    default:           return new Map();
  }
}
```

### Python

```typescript
function inferPython(source: string): InferredTypes {
  const result: InferredTypes = new Map();
  // var = ClassName(...)
  for (const m of source.matchAll(/^\s*(\w+)\s*=\s*([A-Z]\w*)\s*\(/gm))
    result.set(m[1], m[2]);
  // var: ClassName = ...
  for (const m of source.matchAll(/^\s*(\w+)\s*:\s*([A-Z]\w*)\s*=/gm))
    result.set(m[1], m[2]);
  // param: ClassName dans les signatures
  for (const m of source.matchAll(/\b(\w+)\s*:\s*([A-Z]\w*)\b/g))
    result.set(m[1], m[2]);
  return result;
}
```

### C++

```typescript
function inferCpp(source: string): InferredTypes {
  const result: InferredTypes = new Map();
  // ClassName var;  ou  ClassName var(...)
  for (const m of source.matchAll(/\b([A-Z]\w*)\s+(\w+)\s*[;({]/g))
    result.set(m[2], m[1]);
  // ClassName* var = new ClassName(...)
  for (const m of source.matchAll(/\b([A-Z]\w*)\s*\*\s*(\w+)\s*=\s*new\s+\1/g))
    result.set(m[2], m[1]);
  // auto var = make_shared<ClassName>(...)
  for (const m of source.matchAll(/auto\s+(\w+)\s*=\s*(?:make_shared|make_unique)<([A-Z]\w*)>/g))
    result.set(m[1], m[2]);
  // shared_ptr<ClassName> var
  for (const m of source.matchAll(/(?:shared_ptr|unique_ptr|weak_ptr)<([A-Z]\w*)>\s+(\w+)/g))
    result.set(m[2], m[1]);
  return result;
}
```

### TypeScript / JavaScript

```typescript
function inferTypeScript(source: string): InferredTypes {
  const result: InferredTypes = new Map();
  // const var = new ClassName(...)
  for (const m of source.matchAll(/\bconst\s+(\w+)\s*=\s*new\s+([A-Z]\w*)\s*\(/g))
    result.set(m[1], m[2]);
  // let/var var: ClassName =
  for (const m of source.matchAll(/\b(?:let|var|const)\s+(\w+)\s*:\s*([A-Z]\w*)\s*=/g))
    result.set(m[1], m[2]);
  // param: ClassName dans les signatures
  for (const m of source.matchAll(/\b(\w+)\s*:\s*([A-Z]\w*)\b/g))
    result.set(m[1], m[2]);
  return result;
}
```

### Go

```typescript
function inferGo(source: string): InferredTypes {
  const result: InferredTypes = new Map();
  // var var ClassName
  for (const m of source.matchAll(/\bvar\s+(\w+)\s+\*?([A-Z]\w*)\b/g))
    result.set(m[1], m[2]);
  // var := ClassName{...} ou NewClassName(...)
  for (const m of source.matchAll(/\b(\w+)\s*:=\s*(?:New)?([A-Z]\w*)[{(]/g))
    result.set(m[1], m[2]);
  // var := &ClassName{...}
  for (const m of source.matchAll(/\b(\w+)\s*:=\s*&([A-Z]\w*)\s*{/g))
    result.set(m[1], m[2]);
  // paramètre : func f(svc *MyService)
  for (const m of source.matchAll(/\b(\w+)\s+\*?([A-Z]\w*)\b/g))
    result.set(m[1], m[2]);
  return result;
}
```

### Rust

```typescript
function inferRust(source: string): InferredTypes {
  const result: InferredTypes = new Map();
  // let var: TypeName = ...
  for (const m of source.matchAll(/\blet\s+(?:mut\s+)?(\w+)\s*:\s*([A-Z]\w*)\b/g))
    result.set(m[1], m[2]);
  // let var = TypeName::new(...)
  for (const m of source.matchAll(/\blet\s+(?:mut\s+)?(\w+)\s*=\s*([A-Z]\w*)::(?:new|default)\s*\(/g))
    result.set(m[1], m[2]);
  // let var = Box::new(TypeName::new(...))
  for (const m of source.matchAll(/\blet\s+(?:mut\s+)?(\w+)\s*=\s*Box::new\(([A-Z]\w*)::new/g))
    result.set(m[1], m[2]);
  return result;
}
```

### Java

```typescript
function inferJava(source: string): InferredTypes {
  const result: InferredTypes = new Map();
  // ClassName var = new ClassName(...)  ou  ClassName var;
  for (const m of source.matchAll(/\b([A-Z]\w*)\s+(\w+)\s*(?:=|;)/g))
    result.set(m[2], m[1]);
  // Interface var = new ConcreteClass(...)  — préférer le type concret
  for (const m of source.matchAll(/\b([A-Z]\w*)\s+(\w+)\s*=\s*new\s+([A-Z]\w*)\s*\(/g))
    result.set(m[2], m[3]);
  return result;
}
```

### Ruby

```typescript
function inferRuby(source: string): InferredTypes {
  const result: InferredTypes = new Map();
  // var = ClassName.new(...)
  for (const m of source.matchAll(/\b(\w+)\s*=\s*([A-Z]\w*)\.new\b/g))
    result.set(m[1], m[2]);
  return result;
}
```

### Fonction de résolution commune

```typescript
import type { FunctionRegistryTrie } from './function-registry-trie.js';
import type { FunctionNode } from './call-graph.js';

export function resolveViaTypeInference(
  calleeObject: string,
  calleeName: string,
  inferredTypes: InferredTypes,
  trie: FunctionRegistryTrie,
): FunctionNode | undefined {
  const className = inferredTypes.get(calleeObject);
  if (!className) return undefined;
  return trie.findByQualifiedName(className, calleeName)[0];
}
```

### Tests `src/core/analyzer/type-inference-engine.test.ts`

```typescript
import { describe, it, expect } from 'vitest';
import { inferTypesFromSource } from './type-inference-engine.js';

describe('Python', () => {
  it('instantiation directe', () =>
    expect(inferTypesFromSource('service = MyService()\n', 'Python').get('service')).toBe('MyService'));
  it('type hint', () =>
    expect(inferTypesFromSource('repo: UserRepo = get_repo()\n', 'Python').get('repo')).toBe('UserRepo'));
  it('paramètre annoté', () =>
    expect(inferTypesFromSource('def run(svc: MyService): pass', 'Python').get('svc')).toBe('MyService'));
});

describe('C++', () => {
  it('déclaration explicite', () =>
    expect(inferTypesFromSource('MyService svc;', 'C++').get('svc')).toBe('MyService'));
  it('pointeur new', () =>
    expect(inferTypesFromSource('MyService* svc = new MyService();', 'C++').get('svc')).toBe('MyService'));
  it('shared_ptr', () =>
    expect(inferTypesFromSource('shared_ptr<MyService> svc;', 'C++').get('svc')).toBe('MyService'));
  it('make_unique', () =>
    expect(inferTypesFromSource('auto svc = make_unique<MyService>();', 'C++').get('svc')).toBe('MyService'));
});

describe('TypeScript', () => {
  it('new', () =>
    expect(inferTypesFromSource('const svc = new MyService();', 'TypeScript').get('svc')).toBe('MyService'));
  it('annotation', () =>
    expect(inferTypesFromSource('const svc: MyService = inject();', 'TypeScript').get('svc')).toBe('MyService'));
});

describe('Go', () => {
  it('var declaration', () =>
    expect(inferTypesFromSource('var svc *MyService', 'Go').get('svc')).toBe('MyService'));
  it(':= struct literal', () =>
    expect(inferTypesFromSource('svc := MyService{}', 'Go').get('svc')).toBe('MyService'));
});

describe('Rust', () => {
  it('let avec type', () =>
    expect(inferTypesFromSource('let svc: MyService = MyService::new();', 'Rust').get('svc')).toBe('MyService'));
  it('let inféré via ::new', () =>
    expect(inferTypesFromSource('let svc = MyService::new();', 'Rust').get('svc')).toBe('MyService'));
});

describe('Java', () => {
  it('déclaration', () =>
    expect(inferTypesFromSource('MyService svc = new MyService();', 'Java').get('svc')).toBe('MyService'));
});

describe('Ruby', () => {
  it('.new', () =>
    expect(inferTypesFromSource('svc = MyService.new', 'Ruby').get('svc')).toBe('MyService'));
});
```

---

## Phase 5 — `CppHeaderResolver` *(spécifique C++)*

Créer `src/core/analyzer/cpp-header-resolver.ts`.

```typescript
import { dirname, resolve } from 'node:path';

const SYSTEM_HEADERS = new Set([
  'iostream', 'vector', 'string', 'map', 'set', 'unordered_map',
  'memory', 'algorithm', 'functional', 'utility', 'stdexcept',
  'cassert', 'cmath', 'cstdlib', 'cstring', 'thread', 'mutex',
]);

export interface CppInclude {
  headerPath: string;
  isRelative: boolean;
  isSystem: boolean;
}

export function parseCppIncludes(
  filePath: string,
  content: string,
  allFilePaths: string[]
): CppInclude[] {
  const result: CppInclude[] = [];
  const dir = dirname(filePath);

  for (const m of content.matchAll(/#include\s+"([^"]+)"/g)) {
    result.push({ headerPath: resolve(dir, m[1]), isRelative: true, isSystem: false });
  }
  for (const m of content.matchAll(/#include\s+<([^>]+)>/g)) {
    const name = m[1].split('/')[0];
    result.push({ headerPath: m[1], isRelative: false, isSystem: SYSTEM_HEADERS.has(name) });
  }
  return result;
}

/** foo.h + foo.cpp dans le même dossier → même unité de traduction */
export function buildHeaderToImplMap(allFilePaths: string[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const cpp of allFilePaths.filter(f => /\.(cpp|cc)$/.test(f))) {
    const base = cpp.replace(/\.(cpp|cc)$/, '');
    for (const ext of ['.h', '.hpp']) {
      const header = base + ext;
      if (allFilePaths.includes(header)) map.set(header, cpp);
    }
  }
  return map;
}

/** filePath → Set<implFilePath> accessibles via #include */
export function buildCppImportMap(
  files: Array<{ path: string; content: string }>,
  allFilePaths: string[]
): Map<string, Set<string>> {
  const headerToImpl = buildHeaderToImplMap(allFilePaths);
  const result = new Map<string, Set<string>>();

  for (const file of files) {
    if (!/\.(cpp|cc|h|hpp)$/.test(file.path)) continue;
    const includes = parseCppIncludes(file.path, file.content, allFilePaths);
    const accessible = new Set<string>();
    for (const inc of includes) {
      if (inc.isSystem) continue;
      const impl = headerToImpl.get(inc.headerPath);
      if (impl) accessible.add(impl);
    }
    if (accessible.size > 0) result.set(file.path, accessible);
  }
  return result;
}
```

---

## Phase 6 — Intégration dans `CallGraphBuilder.build()`

Remplacer la boucle de résolution (lignes 1253–1274) par la logique multi-stratégies :

```typescript
// Ajouter les imports en tête de call-graph.ts :
import { inferTypesFromSource, resolveViaTypeInference } from './type-inference-engine.js';
import { type ImportMap } from './import-resolver-bridge.js';
import { buildCppImportMap } from './cpp-header-resolver.js';

// Dans build(), après Pass 1 :
// ── Inférence de types par corps de fonction (scope correct, pas fichier entier)
const fileContents = new Map(files.map(f => [f.path, f.content]));
const inferredTypesByFunction = new Map<string, InferredTypes>();
for (const [nodeId, node] of allNodes) {
  const body = (fileContents.get(node.filePath) ?? '').slice(node.startIndex, node.endIndex);
  inferredTypesByFunction.set(nodeId, inferTypesFromSource(body, node.language));
}

const cppImportMap = buildCppImportMap(
  files.map(f => ({ path: f.path, content: f.content })),
  files.map(f => f.path)
);

// Boucle de résolution (remplace le contenu existant) :
for (const raw of allRawEdges) {
  // Stratégie 1 : self / cls Python → intra-classe directe  [confidence: self_cls]
  if (raw.calleeObject === 'self' || raw.calleeObject === 'cls') {
    const callerNode = allNodes.get(raw.callerId);
    if (callerNode?.className) {
      const candidates = trie.findByQualifiedName(callerNode.className, raw.calleeName);
      if (candidates.length > 0) {
        edges.push({ callerId: raw.callerId, calleeId: candidates[0].id,
                     calleeName: raw.calleeName, line: raw.line,
                     confidence: 'self_cls' });
        continue;
      }
    }
  }

  // Stratégie 2 : inférence de type sur le receiver  [confidence: type_inference]
  if (raw.calleeObject && raw.calleeObject !== 'self' && raw.calleeObject !== 'cls') {
    // Types inférés à partir du corps de la fonction appelante uniquement
    const inferredTypes = inferredTypesByFunction.get(raw.callerId);
    if (inferredTypes) {
      const resolved = resolveViaTypeInference(
        raw.calleeObject, raw.calleeName, inferredTypes, trie
      );
      if (resolved) {
        edges.push({ callerId: raw.callerId, calleeId: resolved.id,
                     calleeName: raw.calleeName, line: raw.line,
                     confidence: 'type_inference' });
        continue;
      }
    }
    // Receiver non résolu et non self/cls → ignorer (évite les faux positifs)
    continue;
  }

  // Stratégie 3 : résolution par nom simple + imports + même fichier
  const candidates = trie.findBySimpleName(raw.calleeName);
  if (candidates.length === 0) continue;

  let calleeNode: FunctionNode;
  let confidence: EdgeConfidence;

  if (candidates.length === 1) {
    calleeNode = candidates[0];
    confidence = 'name_only';
  } else {
    const callerNode = allNodes.get(raw.callerId);

    // Stratégie import (TS, JS, Python, Go, Rust, Ruby, Java)  [confidence: import]
    let fromImport: FunctionNode | undefined;
    if (importMap && callerNode) {
      const sourceFile = importMap.get(callerNode.filePath)?.get(raw.calleeName);
      if (sourceFile) {
        fromImport = candidates.find(c =>
          c.filePath === sourceFile || c.filePath.startsWith(sourceFile)
        );
      }
    }

    // Stratégie C++ headers  [confidence: import]
    let fromHeader: FunctionNode | undefined;
    if (!fromImport && callerNode?.language === 'C++') {
      const accessibleImpls = cppImportMap.get(callerNode.filePath);
      if (accessibleImpls) {
        fromHeader = candidates.find(c => accessibleImpls.has(c.filePath));
      }
    }

    const sameFile = candidates.find(c => c.filePath === callerNode?.filePath);

    if (fromImport ?? fromHeader) {
      calleeNode = (fromImport ?? fromHeader)!;
      confidence = 'import';
    } else if (sameFile) {
      calleeNode = sameFile;
      confidence = 'same_file';
    } else {
      calleeNode = candidates[0];
      confidence = 'name_only';
    }
  }

  edges.push({
    callerId: raw.callerId,
    calleeId: calleeNode.id,
    calleeName: raw.calleeName,
    line: raw.line,
    confidence,
  });
}
```

---

## Phase 7 — Edges HTTP cross-langage

`http-route-parser.ts` expose déjà `extractAllHttpEdges()` qui mappe les appels HTTP (fetch/axios/requests/httpx/…) vers les handlers de route (Express, FastAPI, Flask, Go net/http…). Il suffit de brancher sa sortie au call graph.

### 7.1 — Modifier `build()` pour accepter les edges HTTP

```typescript
// Dans build(), après la boucle de résolution des RawEdges :
import { extractAllHttpEdges } from './http-route-parser.js';

const allFilePaths = files.map(f => f.path);
const { edges: httpEdges } = await extractAllHttpEdges(allFilePaths);

for (const httpEdge of httpEdges) {
  // Trouver la fonction appelante la plus proche dans le caller file
  const callerCandidates = Array.from(allNodes.values())
    .filter(n => n.filePath === httpEdge.callerFile);
  // Trouver le handler dans le handler file
  const handlerCandidates = Array.from(allNodes.values())
    .filter(n => n.filePath === httpEdge.handlerFile);

  if (callerCandidates.length === 0 || handlerCandidates.length === 0) continue;

  // Prendre la fonction qui contient la ligne de l'appel HTTP
  const callerNode = callerCandidates.find(n =>
    n.startIndex <= httpEdge.call.line && httpEdge.call.line <= n.endIndex
  ) ?? callerCandidates[0];

  // Prendre le handler dont le nom matche la route (méthode handler de la route)
  const handlerNode = handlerCandidates.find(n =>
    n.name === httpEdge.route.handlerName
  ) ?? handlerCandidates[0];

  edges.push({
    callerId: callerNode.id,
    calleeId: handlerNode.id,
    calleeName: httpEdge.route.handlerName ?? `${httpEdge.method} ${httpEdge.path}`,
    line: httpEdge.call.line,
    confidence: 'http_endpoint',
  });
}
```

### 7.2 — Stocker les métadonnées HTTP dans `CallGraphResult`

```typescript
// Étendre CallGraphResult :
export interface CallGraphResult {
  nodes: FunctionNode[];
  edges: CallEdge[];
  httpEdges: HttpEdge[];  // ← nouveau : accès brut pour les consommateurs
}
```

**Validation :** `npm run test:run` — les tests existants de `http-route-parser` passent sans modification.

---

## Phase 8 — `extractSubgraph` avec budget de tokens

`subgraph-extractor.ts` a `MAX_DEPTH = 2` et `MAX_NODES = 30` en constantes. Remplacer par des paramètres avec des valeurs par défaut qui préservent le comportement actuel.

### 8.1 — Modifier `extractSubgraph`

```typescript
// AVANT
const MAX_DEPTH = 2;
const MAX_NODES = 30;

export function extractSubgraph(
  callGraph: SerializedCallGraph,
  root: FunctionNode,
): SubGraph { ... }

// APRÈS
export interface SubgraphOptions {
  maxDepth?: number;   // défaut: 2
  maxNodes?: number;   // défaut: 30
}

export function extractSubgraph(
  callGraph: SerializedCallGraph,
  root: FunctionNode,
  options: SubgraphOptions = {},
): SubGraph {
  const maxDepth = options.maxDepth ?? 2;
  const maxNodes = options.maxNodes ?? 30;
  // remplacer MAX_DEPTH → maxDepth et MAX_NODES → maxNodes dans visit()
}
```

### 8.2 — Helper `depthFromBudget`

```typescript
/** Traduit un budget de tokens estimé en profondeur de traversal. */
export function depthFromBudget(tokenBudget: number): number {
  if (tokenBudget >= 12_000) return 4;
  if (tokenBudget >= 6_000)  return 3;
  if (tokenBudget >= 2_000)  return 2;
  return 1;
}
```

Seuils calibrés sur ~150 tokens/nœud (signature + fanIn/fanOut), MAX_NODES=30 fixe.

### 8.3 — Brancher dans `buildGraphPromptSection`

```typescript
// artifact-generator.ts appelle buildGraphPromptSection avec un budget
export function buildGraphPromptSection(
  callGraph: SerializedCallGraph,
  signatures: FileSignatureMap,
  tokenBudget?: number,          // ← nouveau paramètre optionnel
): string {
  const maxDepth = tokenBudget ? depthFromBudget(tokenBudget) : 2;
  // ...
  const sub = extractSubgraph(callGraph, godFn, { maxDepth });
  // ...
}
```

**Validation :** `npm run test:run` — zéro régression (les valeurs par défaut sont identiques aux constantes actuelles).

---

## Ordre d'exécution et validation

```
Phase 1 (Trie)              → npm run test:run        ✓ zéro régression
Phase 2 (Receivers)         → npm run test:run        ✓ critique
Phase 3 (ImportBridge)      → npm run test:run        ✓
Phase 4 (TypeInference)     → npm run test:run        ✓
                            → npm run test:integration ✓
Phase 5 (CppHeaderResolver) → npm run test:run        ✓
Phase 6 (Intégration)       → npm run test:run        ✓
                            → npm run test:integration ✓
Phase 7 (HTTP cross-lang)   → npm run test:run        ✓
Phase 8 (Budget tokens)     → npm run test:run        ✓
```

---

## Tests end-to-end à ajouter dans `call-graph.test.ts`

### Python — inférence de type cross-fichier

```typescript
it('résout service.process() via inférence de type', async () => {
  const result = await new CallGraphBuilder().build([
    { path: 'services/my_service.py', language: 'Python', content: `
class MyService:
    def process(self, data):
        return data
    ` },
    { path: 'main.py', language: 'Python', content: `
from services.my_service import MyService
def run():
    service = MyService()
    service.process(payload)
    ` },
  ]);
  expect(edgePairs(result)).toContain('run→process');
});
```

### C++ — pointeur et header

```typescript
it('résout ptr->method() via inférence de type', async () => {
  const result = await new CallGraphBuilder().build([
    { path: 'engine.cpp', language: 'C++', content: `
class Engine {
  void run() {}
};
    ` },
    { path: 'main.cpp', language: 'C++', content: `
#include "engine.h"
void start() {
  Engine* eng = new Engine();
  eng->run();
}
    ` },
  ]);
  expect(edgePairs(result)).toContain('start→run');
});
```

---

## Tableau de synthèse par langage

| Langage | Phase 2 (receiver) | Phase 3 (imports) | Phase 4 (inférence) | Phase 5 (headers) |
|---------|-------------------|-------------------|---------------------|-------------------|
| **Python** | Lever filtre self/cls | `from x import y` via import-parser | 3 règles + type hints | — |
| **C++** | Capturer `arg` + `ptr->` | — | 5 règles incl. smart_ptr | `#include` → .cpp |
| TypeScript | Capturer `object` de member_expr | import-parser.ts existant | 3 règles | — |
| Go | Capturer `operand` de selector | imports relatifs | 3 règles | — |
| Rust | Capturer `value` de field_expr | `use` relatifs | 3 règles | — |
| Java | Capturer `object` de method_invocation | `import com.Foo` → fichier | 2 règles | — |
| Ruby | Capturer `receiver` de call | `require_relative` | 1 règle (`.new`) | — |

---

## Points d'attention

| Risque | Mitigation |
|--------|------------|
| `rawEdge.calleeObject` est un champ nouveau — tous les extracteurs doivent être mis à jour | Vérifier les 7 fonctions : `extractPyGraph`, `extractCppGraph`, `extractTSGraph`, `extractGoGraph`, `extractRustGraph`, `extractRubyGraph`, `extractJavaGraph` |
| Faux positifs C++ : regex classe sur variables locales | Limiter aux noms commençant par majuscule (convention classe C++) |
| `imp.source` dans import-parser.ts est un chemin relatif brut | Utiliser `resolve(dir, imp.source)` — déjà fait dans le bridge |
| Les tests d'intégration existants (`regression.integration.test.ts`) | Les exécuter après chaque phase, pas seulement à la fin |
| `CallEdge.calleeId` est `''` pour les appels non résolus | Contrat conservé : ne jamais remplacer la chaîne vide par autre chose |
| Scope des types inférés : fichier entier → pollution inter-fonctions | Passer `content.slice(node.startIndex, node.endIndex)` — indexer par `functionId`, pas `filePath` |
| `confidence` ajouté à `CallEdge` — champ nouveau | Vérifier que les consommateurs de `CallGraphResult` (artifact-generator, tests) ne cassent pas si le champ est inconnu ; `name_only` est la valeur par défaut la plus permissive |
| Phase 7 : `startIndex`/`endIndex` de `FunctionNode` sont des offsets caractères, pas des numéros de ligne | Vérifier que `httpEdge.call.line` est bien en lignes — utiliser `node.startLine`/`node.endLine` si disponible, sinon convertir |
| Phase 8 : seuils de `depthFromBudget` sont des estimations | Calibrer sur les vrais specs générés une fois les phases 1–7 en place |
