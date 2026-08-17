/**
 * McCabe cyclomatic-complexity estimator — extracted from `call-graph.ts`
 * (change: modularize-call-graph-builder; analyzer: StableCallGraphBarrel).
 *
 * A pure, dependency-free lexical approximation (CC = 1 + decision points) used to
 * rank/triage function complexity. `computeCyclomaticComplexity` was exported from
 * `call-graph.ts`, so it is re-exported there to keep the public import surface
 * unchanged; the `CC_PATTERN_*` tables stay private to this module.
 */

const CC_PATTERN_PYTHON = /\bif\s|\belif\s|\bwhile\s|\bfor\s|\bexcept\b|\band\s|\bor\s/g;
const CC_PATTERN_C_FAMILY = /\bif\s*\(|\bwhile\s*\(|\bfor\s*[(]|\bcase\s+|\bcatch\s*\(|&&|\|\|/g;
const CC_PATTERN_GO = /\bif\b|\bfor\b|\bcase\b|&&|\|\|/g;
const CC_PATTERN_RUST = /\bif\b|\bwhile\b|\bfor\b|\bloop\b|&&|\|\|/g;
const CC_PATTERN_SWIFT = /\bif\b|\bguard\b|\bwhile\b|\bfor\b|\bcase\b|\bcatch\b|&&|\|\|/g;
const CC_PATTERN_RUBY = /\bif\b|\belsif\b|\bunless\b|\bwhile\b|\buntil\b|\bwhen\b|\brescue\b|\band\b|\bor\b|&&|\|\|/g;
const CC_PATTERN_ELIXIR = /\bif\b|\bunless\b|\brescue\b|\band\b|\bor\b|&&|\|\|/g;
const CC_PATTERN_KOTLIN = /\bif\s*\(|\bwhile\s*\(|\bfor\s*[(]|\bcatch\s*\(|&&|\|\|/g;
const CC_PATTERN_SCALA = /\bif\b|\bwhile\b|\bfor\b|\bcase\b|\bcatch\b|&&|\|\|/g;
const CC_PATTERN_PHP = /\bif\s*\(|\belseif\s*\(|\bwhile\s*\(|\bfor\s*[(]|\bforeach\s*\(|\bcase\s+|\bcatch\s*\(|&&|\|\|/g;
const CC_PATTERN_CSHARP = /\bif\s*\(|\bwhile\s*\(|\bfor\s*[(]|\bforeach\s*\(|\bcase\s+|\bcatch\s*\(|&&|\|\|/g;

const C_FAMILY_LANGUAGES = [
  'TypeScript', 'JavaScript', 'Java', 'C', 'C++', 'Dart',
] as const;

/**
 * Authoritative language-to-pattern table (change: fix-complexity-language-parity).
 * The capability registry derives its `complexity` column from these keys.
 */
const CC_PATTERNS: ReadonlyMap<string, RegExp> = new Map([
  ...C_FAMILY_LANGUAGES.map(language => [language, CC_PATTERN_C_FAMILY] as const),
  ['Python', CC_PATTERN_PYTHON],
  ['Go', CC_PATTERN_GO],
  ['Rust', CC_PATTERN_RUST],
  ['Swift', CC_PATTERN_SWIFT],
  ['Ruby', CC_PATTERN_RUBY],
  ['Elixir', CC_PATTERN_ELIXIR],
  ['Kotlin', CC_PATTERN_KOTLIN],
  ['Scala', CC_PATTERN_SCALA],
  ['PHP', CC_PATTERN_PHP],
  ['C#', CC_PATTERN_CSHARP],
]);

/** Languages for which the estimator has a grammar-shaped decision pattern. */
export const COMPLEXITY_LANGUAGES: ReadonlySet<string> = new Set(CC_PATTERNS.keys());

function maskSpan(chars: string[], start: number, endExclusive: number): number {
  chars[start] = 'L';
  let needsSentinel = false;
  for (let i = start + 1; i < endExclusive; i++) {
    if (chars[i] === '\n') {
      needsSentinel = true;
    } else {
      chars[i] = needsSentinel ? 'L' : ' ';
      needsSentinel = false;
    }
  }
  return endExclusive - 1;
}

function maskNonCode(body: string, language: string): string {
  // Delimiters are ASCII, so UTF-16 indexing keeps `chars[i]` aligned with body.slice(i).
  const chars = body.split('');
  const hashComments = language === 'Python' || language === 'Ruby' || language === 'Elixir';
  for (let i = 0; i < chars.length; i++) {
    const quote = chars[i];
    const rustRaw = language === 'Rust' ? body.slice(i).match(/^(?:br|r)(#*)"/) : undefined;
    if (rustRaw) {
      const closing = `"${rustRaw[1]}`;
      const end = body.indexOf(closing, i + rustRaw[0].length);
      if (end >= 0) {
        i = maskSpan(chars, i, end + closing.length);
        continue;
      }
    }

    const triple = body.startsWith('"""', i) ? '"""' : body.startsWith("'''", i) ? "'''" : undefined;
    if (triple) {
      const end = body.indexOf(triple, i + triple.length);
      if (end >= 0) {
        i = maskSpan(chars, i, end + triple.length);
        continue;
      }
    }

    const rubyPercent = language === 'Ruby' ? body.slice(i).match(/^%[qQ](.)/) : undefined;
    if (rubyPercent) {
      const pairs: Record<string, string> = { '(': ')', '{': '}', '<': '>', '[': ']' };
      const open = rubyPercent[1];
      const close = pairs[open];
      if (close) {
        let depth = 1;
        let end = i + rubyPercent[0].length;
        for (; end < body.length && depth > 0; end++) {
          if (body[end] === '\\') end++;
          else if (body[end] === open) depth++;
          else if (body[end] === close) depth--;
        }
        if (depth === 0) {
          i = maskSpan(chars, i, end);
          continue;
        }
      }
    }

    const apostropheTokenLanguage = language === 'Rust' || language === 'Scala';
    const charLiteral = apostropheTokenLanguage && quote === "'"
      ? body.slice(i).match(/^'(?:\\.|[^'\\\n])'/u)?.[0]
      : undefined;
    if (quote === '"' || quote === '`' || (quote === "'" && (!apostropheTokenLanguage || charLiteral))) {
      let end = i + 1;
      for (; end < chars.length; end++) {
        if (chars[end] === '\\') end++;
        else if (chars[end] === quote) {
          end++;
          break;
        }
      }
      i = maskSpan(chars, i, end);
    } else if ((quote === '/' && chars[i + 1] === '/') || (hashComments && quote === '#')) {
      while (i < chars.length && chars[i] !== '\n') chars[i++] = ' ';
      i--;
    } else if (quote === '/' && chars[i + 1] === '*') {
      let depth = 1;
      chars[i++] = ' ';
      chars[i] = ' ';
      while (++i < chars.length && depth > 0) {
        if (chars[i] === '/' && chars[i + 1] === '*') {
          depth++;
          chars[i++] = ' ';
          chars[i] = ' ';
        } else if (chars[i] === '*' && chars[i + 1] === '/') {
          depth--;
          chars[i++] = ' ';
          chars[i] = ' ';
        } else if (chars[i] !== '\n') {
          chars[i] = ' ';
        }
      }
    }
  }
  return chars.join('');
}

function matchingBrace(body: string, open: number): number {
  let depth = 0;
  for (let i = open + 1; i < body.length; i++) {
    if (body[i] === '{') depth++;
    else if (body[i] === '}' && depth-- === 0) return i;
  }
  return -1;
}

function hasTopLevelArrow(body: string, open: number, close: number, arrow: string): boolean {
  let depth = 0;
  for (let i = open + 1; i < close; i++) {
    if (body[i] === '{') depth++;
    else if (body[i] === '}') depth--;
    else if (depth === 0 && body.startsWith(arrow, i)) return true;
  }
  return false;
}

function findArmBlock(body: string, start: number, arrow: string): number {
  let parenDepth = 0;
  let bracketDepth = 0;
  for (let i = start; i < body.length; i++) {
    const char = body[i];
    if (char === '(') parenDepth++;
    else if (char === ')') parenDepth--;
    else if (char === '[') bracketDepth++;
    else if (char === ']') bracketDepth--;
    else if (char === '{' && parenDepth === 0 && bracketDepth === 0) {
      const close = matchingBrace(body, i);
      if (close < 0) return -1;
      if (hasTopLevelArrow(body, i, close, arrow)) return i;
      i = close;
    }
  }
  return -1;
}

function countBraceConstructArms(
  body: string,
  keyword: 'match' | 'when',
  arrow: '=>' | '->',
  defaultArm: RegExp,
): number {
  const construct = new RegExp(`\\b${keyword}\\b`, 'g');
  let count = 0;
  for (let match = construct.exec(body); match; match = construct.exec(body)) {
    const open = findArmBlock(body, match.index + match[0].length, arrow);
    if (open < 0) continue;
    let depth = 0;
    let segmentStart = open + 1;
    let armSeen = false;
    for (let i = open + 1; i < body.length; i++) {
      const char = body[i];
      if (char === '{') {
        depth++;
      } else if (char === '}') {
        if (depth === 0) {
          break;
        }
        depth--;
        if (depth === 0 && armSeen) {
          segmentStart = i + 1;
          armSeen = false;
        }
      } else if (depth === 0 && body.startsWith(arrow, i)) {
        const clause = body.slice(segmentStart, i).trim();
        if (clause && !defaultArm.test(clause)) count++;
        armSeen = true;
        i += arrow.length - 1;
      } else if (depth === 0 && (char === ',' || char === ';' || char === '\n')) {
        segmentStart = i + 1;
        armSeen = false;
      }
    }
    construct.lastIndex = match.index + match[0].length;
  }
  return count;
}

function countElixirBranchArms(body: string): number {
  const construct = /\b(case|cond)\b/g;
  let count = 0;
  for (let match = construct.exec(body); match; match = construct.exec(body)) {
    const opener = /\bdo\b(?!:)/g;
    opener.lastIndex = match.index + match[0].length;
    const open = opener.exec(body);
    if (!open) continue;

    let depth = 0;
    let segmentStart = open.index + open[0].length;
    const token = /\b(?:do|fn|end)\b(?!:)|->|[;\n]/g;
    token.lastIndex = segmentStart;
    for (let part = token.exec(body); part; part = token.exec(body)) {
      if (part[0] === 'do' || part[0] === 'fn') {
        depth++;
      } else if (part[0] === 'end') {
        if (depth === 0) {
          break;
        }
        depth--;
      } else if (part[0] === '->' && depth === 0) {
        const clause = body.slice(segmentStart, part.index).trim();
        const isDefault = match[1] === 'cond'
          ? /^true$/.test(clause)
          : /^(?:_|_[a-z]\w*|(?!true$|false$|nil$)[a-z]\w*)$/.test(clause);
        if (clause && !isDefault) count++;
      } else if (depth === 0) {
        segmentStart = part.index + part[0].length;
      }
    }
    construct.lastIndex = match.index + match[0].length;
  }
  return count;
}

/**
 * McCabe cyclomatic complexity via lightweight lexical analysis of a function body.
 * CC = 1 + decision points (if, while, for, case, catch, &&, ||).
 * Approximate (regex, not AST), suitable for triage/ranking.
 */
export function computeCyclomaticComplexity(body: string, language: string): number | undefined {
  const pattern = CC_PATTERNS.get(language);
  if (!pattern) return undefined;
  // Swift's `if case` / `guard case` is one conditional, not a switch arm.
  const code = maskNonCode(body, language);
  const normalized = language === 'Swift'
    ? code.replace(/\b(if|guard|while)\s+case\b/g, '$1 ')
    : code;
  const keywordDecisions = normalized.match(new RegExp(pattern.source, pattern.flags))?.length ?? 0;
  const armDecisions = language === 'Rust'
    ? countBraceConstructArms(normalized, 'match', '=>', /^(?:_|(?:ref\s+)?mut\s+\w+|ref\s+\w+|(?!true$|false$)[a-z]\w*|\w+\s*@\s*_)$/)
    : language === 'Kotlin'
      ? countBraceConstructArms(normalized, 'when', '->', /^else\b/)
      : language === 'Elixir'
        ? countElixirBranchArms(normalized)
        : 0;
  return 1 + keywordDecisions + armDecisions;
}
