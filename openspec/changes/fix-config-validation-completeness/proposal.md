# Config validation must catch what actually breaks the run, and `doctor` must not bless a config that does

> Status: PROPOSED (2026-07-26). Found by an end-to-end pass against a hostile repository; the
> failures reproduce on an ordinary hand-edited config and predate PR #292. Deterministic, no LLM,
> no new dependency.

## The gap

`add-config-schema-validation` gave `.openlore/config.json` a validator and a `doctor` check. It
catches unknown keys and some wrong types. It does not catch the two shapes that actually stop the
tool from working, and `doctor` reports a clean bill of health for a config that makes `analyze`
crash.

### 1. A config missing a required section crashes the run with an internal error

```
$ echo '{}' > .openlore/config.json && openlore analyze
  Project: undefined
[error] Analysis failed: Cannot read properties of undefined (reading 'excludePatterns')
```

This is not exotic: any hand-written or hand-trimmed config missing the `analysis` block does it, as
does a config written by an older version, or one a user reduced while debugging. The user gets a
JavaScript `TypeError` naming an internal property — no indication that the *config* is the problem,
which key is missing, or how to repair it.

### 2. `doctor` gives that exact config a clean bill of health

```
$ openlore doctor          # same '{}' config
✓  Config schema          all keys known and well-typed
```

The one check whose job is to tell the user their config is sound reports success for a config that
crashes the primary command. That is worse than having no check: it actively directs the user away
from the cause. The validator's model is "known keys, well-typed *when present*" — it has no notion
of a section being *required*, so absence reads as valid.

### 3. Type checking is incomplete where it does exist

`analysis.maxFiles: "lots"` passes validation. The validator flagged the unknown key in the same
file but not this type error, so the type coverage is partial in a way the output does not admit —
a user who sees "all keys known and well-typed" reasonably concludes their values were checked.

## What changes

**Validate what the code actually requires, and make `doctor`'s verdict answer the question the user
is really asking: "will this config work?"**

- **Required sections are part of the schema.** The validator distinguishes *absent* from *present
  and wrong*, and reports a missing required section as a finding naming the key and the fix. Where
  a section is genuinely optional, the code that reads it SHALL tolerate its absence — so "required"
  in the schema and "dereferenced unconditionally" in the code cannot drift apart.
- **Reads of config are defensive at the boundary.** A missing or malformed section produces a
  diagnosed, actionable error attributing the failure to the config file and the key — never a raw
  `TypeError` naming an internal property.
- **Type coverage is complete for declared fields, and honest where it is not.** Every field the
  schema declares is type-checked; a field the validator cannot check does not get counted in a
  "well-typed" claim.
- **`doctor`'s summary line cannot outrun its evidence.** The check reports "all keys known and
  well-typed" only when it actually verified that; a config with a missing required section reports
  a finding with the key and the remedy.

The through-line matches the substrate's existing contract: a green check is a claim, and a claim
must be supported. `doctor` blessing a config that crashes `analyze` is the same class of defect as
a conclusion tool reporting `0` for something it never computed.
