/**
 * Real prompts and the files the agent then worked on, from Claude Code transcripts (JSONL), for
 * measuring the prompt briefing against what agents actually needed. Deterministic: a briefing is
 * scored by whether the files it names were later read or edited in that turn; no LLM judge.
 *
 * Reads local files only; nothing is sent anywhere. change: anchor-gated-prompt-briefing
 */
export interface TranscriptTurn {
  prompt: string;
  /** Repository-relative files the agent read, edited or named in a shell command before the next prompt. */
  touched: string[];
}

const REPO_PATH = /(?<![\w/.-])((?:src|lib|app|scripts|bench|docs|plugin|openspec|skills|test|tests|packages)\/[\w./-]+\.\w+)/g;

function repoRelative(path: string, roots: readonly string[]): string | undefined {
  for (const root of roots) {
    const prefix = root.endsWith('/') ? root : `${root}/`;
    if (path.startsWith(prefix)) return path.slice(prefix.length);
  }
  return undefined;
}

/**
 * The human prompts in one transcript, each with the files touched before the next prompt. Tool
 * results, meta messages and harness notices (`<task-notification>`, compaction summaries) are not
 * prompts. `roots` are the absolute repository roots whose files count (a worktree and its parent).
 */
export function turnsFromTranscript(jsonl: string, roots: readonly string[]): TranscriptTurn[] {
  const turns: Array<{ prompt: string; touched: Set<string> }> = [];
  let current: { prompt: string; touched: Set<string> } | undefined;
  for (const line of jsonl.split('\n')) {
    if (!line.trim()) continue;
    let entry: Record<string, unknown>;
    try { entry = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
    const message = entry.message as { content?: unknown } | undefined;
    if (entry.type === 'user' && !entry.isMeta) {
      const content = message?.content;
      const parts = Array.isArray(content) ? content as Array<Record<string, unknown>> : [];
      if (parts.some(p => p?.type === 'tool_result')) continue;
      const text = typeof content === 'string' ? content : parts.filter(p => p?.type === 'text').map(p => String(p.text ?? '')).join('');
      const trimmed = text.trim();
      if (!trimmed || trimmed.startsWith('<') || trimmed.startsWith('This session is being continued')) { current = undefined; continue; }
      current = { prompt: text, touched: new Set() };
      turns.push(current);
      continue;
    }
    if (entry.type !== 'assistant' || !current) continue;
    const parts = Array.isArray(message?.content) ? message!.content as Array<Record<string, unknown>> : [];
    for (const part of parts) {
      if (part?.type !== 'tool_use') continue;
      const input = (part.input ?? {}) as Record<string, unknown>;
      for (const key of ['file_path', 'path', 'notebook_path']) {
        const rel = typeof input[key] === 'string' ? repoRelative(input[key] as string, roots) : undefined;
        if (rel) current.touched.add(rel);
      }
      if (part.name === 'Bash' && typeof input.command === 'string') {
        for (const m of input.command.matchAll(REPO_PATH)) current.touched.add(m[1]);
      }
    }
  }
  return turns.map(t => ({ prompt: t.prompt, touched: [...t.touched].sort() }));
}

/** The repository files a briefing names (`— path` in function lines, and the files line). */
export function filesInBriefing(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/— ([\w./-]+\.\w+)/g)) out.add(m[1]);
  for (const m of text.matchAll(/Relevant files[^:]*: ([^\n]+)/g)) for (const f of m[1].split(',')) if (f.trim()) out.add(f.trim());
  return [...out].sort();
}

export interface BriefingScore { prompts: number; briefings: number; withHit: number; meanPrecision: number; meanChars: number }

/** Score briefings against touched files: hit = names at least one touched file. */
export function scoreBriefings(rows: ReadonlyArray<{ briefing: string; touched: readonly string[] }>): BriefingScore {
  const briefed = rows.filter(r => /Relevant f/.test(r.briefing));
  let withHit = 0; let precision = 0; let chars = 0;
  for (const r of briefed) {
    const named = filesInBriefing(r.briefing);
    const hits = named.filter(f => r.touched.includes(f)).length;
    if (hits) withHit++;
    precision += named.length ? hits / named.length : 0;
    chars += r.briefing.length;
  }
  const n = briefed.length || 1;
  return { prompts: rows.length, briefings: briefed.length, withHit, meanPrecision: precision / n, meanChars: Math.round(chars / n) };
}
