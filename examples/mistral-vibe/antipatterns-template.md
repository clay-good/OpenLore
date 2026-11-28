# Project Antipatterns

Failure patterns discovered post-merge. Automatically checked by agents during
brainstorm and implementation via `openlore-brainstorm` and `openlore-implement-story`.

To add an entry: run `/openlore-debug` — Step 7 evaluates whether the bug
qualifies as a cross-cutting antipattern and appends here if so.

---

<!-- Add entries below. Use AP-NNN numbering. -->

## AP-001 — {pattern name}

- **Class**: {state | concurrency | boundary | assumption | resource | ordering}
- **Symptom**: {what broke in production — one sentence}
- **Rule**: {detection rule agents should check — "When X, always verify Y"}
- **Discovered**: {YYYY-MM-DD} via {one-line bug summary}
