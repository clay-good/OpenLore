import { blankCommentsPreservingLayout } from './comment-blanking.js';

export interface JavaMethodDeclaration {
  name: string;
  access: 'public' | 'private' | 'protected';
  start: number;
  parameterStart: number;
}

const ACCESS_MODIFIERS = new Set(['public', 'private', 'protected']);
const METHOD_MODIFIERS = new Set([
  'static', 'final', 'abstract', 'synchronized', 'default', 'native', 'strictfp',
]);
const TYPE_DECLARATIONS = new Set(['class', 'interface', 'enum', 'record']);
const NON_METHOD_NAMES = new Set(['if', 'for', 'while', 'switch', 'catch', 'new', 'return']);

function isIdentifierStart(char: string | undefined): boolean {
  return char !== undefined && /[A-Za-z_$]/.test(char);
}

function isIdentifierPart(char: string | undefined): boolean {
  return char !== undefined && /[\w$]/.test(char);
}

/**
 * Find Java method declarations with one forward pass over source text.
 *
 * This intentionally recognizes only declarations carrying an explicit access
 * modifier. It is a small lexical scanner, not a Java parser: declaration state is
 * reset at top-level statement/body boundaries, and strings/comments are skipped.
 * Unlike the former regexes, malformed generic prefixes never cause the same suffix
 * to be rescanned from every `public` token, and valid return types have no arbitrary
 * whitespace-token limit.
 */
export function scanJavaMethodDeclarations(
  source: string,
  allowedAccess: ReadonlySet<string> = new Set(['public']),
): JavaMethodDeclaration[] {
  const text = blankCommentsPreservingLayout(source);
  const declarations: JavaMethodDeclaration[] = [];
  let access: JavaMethodDeclaration['access'] | undefined;
  let accessIndex = -1;
  let angleDepth = 0;
  let parenDepth = 0;
  let topLevelIdentifiers = 0;
  let forbidden = false;
  let assigned = false;
  let methodFound = false;
  let annotationState: 'none' | 'expect-name' | 'after-name' = 'none';
  let previousToken = '';
  let previousTokenKind: 'identifier' | 'symbol' | '' = '';

  const reset = (): void => {
    access = undefined;
    accessIndex = -1;
    angleDepth = 0;
    parenDepth = 0;
    topLevelIdentifiers = 0;
    forbidden = false;
    assigned = false;
    methodFound = false;
    annotationState = 'none';
    previousToken = '';
    previousTokenKind = '';
  };

  for (let i = 0; i < text.length;) {
    const char = text[i];

    if (/\s/.test(char)) {
      i++;
      continue;
    }

    if (char === '"' || char === "'" || char === '`') {
      const quote = char;
      i++;
      while (i < text.length) {
        if (text[i] === '\\') {
          i += 2;
          continue;
        }
        const current = text[i++];
        if (current === quote) break;
      }
      previousToken = 'string';
      previousTokenKind = 'symbol';
      annotationState = 'none';
      continue;
    }

    if (isIdentifierStart(char)) {
      const start = i++;
      while (isIdentifierPart(text[i])) i++;
      const word = text.slice(start, i);

      if (parenDepth === 0 && angleDepth === 0) {
        if (!access && ACCESS_MODIFIERS.has(word) && allowedAccess.has(word)) {
          access = word as JavaMethodDeclaration['access'];
          accessIndex = start;
        } else if (access) {
          if (TYPE_DECLARATIONS.has(word) || (previousToken === '@' && word === 'interface')) {
            forbidden = true;
          }
          const isAnnotationPart = annotationState === 'expect-name';
          if (!isAnnotationPart && !METHOD_MODIFIERS.has(word) && !ACCESS_MODIFIERS.has(word)) {
            topLevelIdentifiers++;
          }
        }
      }

      if (annotationState === 'expect-name') annotationState = 'after-name';
      else if (annotationState === 'after-name') annotationState = 'none';

      previousToken = word;
      previousTokenKind = 'identifier';
      continue;
    }

    const opensAnnotationArguments = char === '(' && annotationState === 'after-name';
    if (char === '@') annotationState = 'expect-name';
    else if (char === '.' && annotationState === 'after-name') annotationState = 'expect-name';
    else if (char !== '(' && char !== '.') annotationState = 'none';

    if (char === '(') {
      if (parenDepth === 0 && angleDepth === 0 && access && !methodFound
          && !opensAnnotationArguments
          && previousTokenKind === 'identifier' && previousToken !== 'interface'
          && previousToken !== 'record' && !NON_METHOD_NAMES.has(previousToken)
          && !forbidden && !assigned && topLevelIdentifiers >= 2) {
        declarations.push({
          name: previousToken,
          access,
          start: accessIndex,
          parameterStart: i,
        });
        methodFound = true;
      }
      parenDepth++;
      annotationState = 'none';
    } else if (char === ')' && parenDepth > 0) {
      parenDepth--;
    } else if (parenDepth === 0) {
      if (char === '<') angleDepth++;
      else if (char === '>' && angleDepth > 0) angleDepth--;
      else if (char === '=') assigned = true;
      else if (char === ';' || char === '{' || char === '}') {
        reset();
        i++;
        continue;
      }
    }

    previousToken = char;
    previousTokenKind = 'symbol';
    i++;
  }

  return declarations;
}
