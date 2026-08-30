# Troubleshooting Guide

Common issues and solutions when using openlore.

> **Start here:** run `openlore doctor`. It checks your Node version, git repo, config,
> index freshness, MCP wiring, and LLM/embedding setup,
> and prints the exact command to fix anything that is missing.

## Installation Issues

### CLI Not Found

**Problem**: `openlore` command not recognized after install

**Solution**:
```bash
cd openlore
npm install && npm run build && npm link
```
If `npm link` requires permissions: `sudo npm link`

### Skill Not Found (Claude Code)

**Problem**: `/openlore` command not recognized in Claude Code

**Solution**:
1. Verify the skill file exists:
   ```bash
   ls -la .claude/skills/openlore.md
   ```
2. Check file permissions are readable
3. Restart Claude Code session
4. Ensure you're in the correct project directory

### Permission Denied

**Problem**: Can't create `.claude/skills/` directory

**Solution**:
```bash
mkdir -p .claude/skills
chmod 755 .claude/skills
```

## API Key & LLM Issues

### No API Key Found

**Problem**: `No LLM API key found.`

**Solution**: Set one of:
```bash
export ANTHROPIC_API_KEY=sk-ant-...
# or
export OPENAI_API_KEY=sk-...
```

Only `generate`, `verify`, and `drift --use-llm` require an API key. Commands like `analyze`, `drift`, and `init` work without one.

### Custom Endpoint Not Working

**Problem**: Errors when using `--api-base` with a local or enterprise server

**Solutions**:

1. **Verify the URL is valid and includes the version path**:
   ```bash
   # Correct:
   openlore generate --api-base http://localhost:8000/v1

   # Wrong (missing /v1):
   openlore generate --api-base http://localhost:8000
   ```

2. **For self-signed certificates**:
   ```bash
   openlore generate --api-base https://internal.corp.net/v1 --insecure
   ```

3. **Check that the server is running and reachable**:
   ```bash
   curl http://localhost:8000/v1/models
   ```

4. **Local servers often need a dummy API key**:
   ```bash
   export OPENAI_API_KEY=dummy-key
   openlore generate --api-base http://localhost:8000/v1
   ```

### SSL Certificate Error

**Problem**: `UNABLE_TO_VERIFY_LEAF_SIGNATURE` or similar TLS error

**Solution**: Use the `--insecure` flag or set `sslVerify: false` in config:
```bash
openlore generate --insecure
```
Or in `.openlore/config.json`:
```json
{
  "llm": {
    "sslVerify": false
  }
}
```

> **Warning**: This disables SSL verification process-wide. Only use with trusted internal servers.

### Wrong Provider Selected

**Problem**: openlore is using Anthropic when you want OpenAI (or vice versa)

**How provider selection works**: If `ANTHROPIC_API_KEY` is set, Anthropic is used. Otherwise, if `OPENAI_API_KEY` is set, OpenAI is used. To force a specific provider, only set that provider's API key.

### Configuration Priority

Settings are resolved in this order (first match wins):

1. CLI flags (`--api-base`, `--insecure`)
2. Environment variables (`OPENAI_API_BASE`, `ANTHROPIC_API_BASE`)
3. Config file (`.openlore/config.json` → `llm.apiBase`, `llm.sslVerify`)
4. Provider defaults (`https://api.anthropic.com/v1` or `https://api.openai.com/v1`)

## Generation Issues

### Invalid Schema for response_format (OpenAI)

**Problem**: `Invalid schema for response_format 'response': schema must be a JSON Schema of 'type: "object"', got 'type: "array"'`

**Cause**: Fixed in v1.2.7. Earlier versions sent top-level `type: "array"` schemas to OpenAI's structured output API, which requires `type: "object"` at the root.

**Solution**: Upgrade to v1.2.7+:
```bash
npm install -g openlore@latest
```

### No Domains Detected

**Problem**: openlore says "Could not identify any domains"

**Possible Causes**:
1. Very flat project structure
2. Unconventional naming patterns
3. Monolithic codebase without clear separation

**Solutions**:
- Ensure project has some directory structure
- Check that source files aren't all in root
- Consider manual domain hints in instructions:
  ```
  /openlore
  Consider these domains: user, order, payment
  ```

### Too Many Domains Generated

**Problem**: openlore creates specs for every directory

**Solution**: Add guidance to limit scope:
```
/openlore
Focus on core business domains only. Ignore utilities, helpers, and infrastructure.
```

### Empty or Minimal Specs

**Problem**: Generated specs have very few requirements

**Possible Causes**:
1. Limited code in analyzed files
2. Heavy use of external libraries
3. Generated/compiled code being analyzed

**Solutions**:
- Point to source files, not build output
- Ensure `.gitignore` patterns are respected
- Check that high-value files (models, services) exist

### Incorrect Requirements

**Problem**: Generated requirements don't match actual code behavior

**This is expected sometimes**. Remember: "Archaeology over Creativity" means we should flag uncertainty rather than guess.

**Solutions**:
1. Review and edit generated specs manually
2. Add `**Confidence**: Low` markers
3. Remove requirements that can't be verified
4. File an issue if patterns consistently fail

## Format Issues

### OpenSpec Validation Fails

**Problem**: `openspec validate --all` reports errors

**Common Issues**:

1. **Missing RFC 2119 keywords**
   ```
   Error: Requirement doesn't use SHALL/MUST/SHOULD/MAY
   ```
   Fix: Edit requirement to include keyword:
   ```markdown
   The system SHALL validate email format.
   ```

2. **Wrong scenario heading level**
   ```
   Error: Scenario must use #### heading
   ```
   Fix: Ensure scenarios use exactly 4 hashtags:
   ```markdown
   #### Scenario: ValidEmail
   ```

3. **Missing Given/When/Then**
   ```
   Error: Scenario missing required format
   ```
   Fix: Ensure all three parts exist with bold labels:
   ```markdown
   - **GIVEN** precondition
   - **WHEN** action
   - **THEN** outcome
   ```

### Markdown Rendering Issues

**Problem**: Specs don't render correctly in viewers

**Solutions**:
- Ensure blank lines before/after code blocks
- Check for unclosed formatting (**, `, etc.)
- Verify heading hierarchy is correct

## Performance Issues

### Generation Takes Too Long

**Problem**: openlore seems stuck or very slow

**Possible Causes**:
1. Very large codebase
2. Too many files being analyzed
3. Deep directory nesting

**Solutions**:
- Add exclusions for large directories:
  ```
  /openlore
  Exclude: node_modules, dist, build, coverage, .git
  ```
- Focus on specific directories:
  ```
  /openlore
  Focus on src/core and src/services only
  ```

### Out of Context Errors

**Problem**: Claude Code runs out of context during generation

**Solutions**:
1. Split into multiple runs by domain
2. Reduce scope per run
3. Use the agents.md approach which can work incrementally

### Watch Mode Reports a Stale Region

**Problem**: A watcher debug line reports files as stale, or a recalled anchor has
`staleRegion: true`.

**Cause**: One edit affected more reverse dependencies than the incremental closure budget can
recompute without stalling the watcher. OpenLore recomputes the most structurally significant
files first and explicitly marks every deferred file stale. The reported hub/chokepoint counts
and top symbol describe the affected region; they do not make a low-significance stale result
authoritative.

**Solution**: Let the scheduled background rebuild converge. If it cannot run, execute:

```bash
openlore analyze --reanalyze
```

The ordering uses fan-in/fan-out from the graph being updated, so it is a best-effort priority
signal and may temporarily be a lower bound after recent edits. Files with no usable signal fall
back to stable path order. Test callers receive a bounded budget slot so test-to-production
reachability is not systematically deferred.

If `closureBudget` is explicitly configured to `1`, one update cannot reserve work for both
production and test callers. OpenLore keeps the highest-significance production caller, and the
debug summary discloses that test reachability was deferred. The default budget of 40 does not
have this limitation.

## Drift Detection Issues

### No Base Branch Detected

**Problem**: `Could not detect base branch`

**Solution**: Specify the base branch explicitly:
```bash
openlore drift --base main
# or
openlore drift --base develop
```

### Too Many False Positives

**Problem**: Drift detection flags changes that don't affect specs (renames, formatting)

**Solution**: Use LLM-enhanced mode to filter non-relevant changes:
```bash
openlore drift --use-llm
```
This sends each diff to the LLM for semantic analysis, classifying changes as relevant or not.

### Pre-Commit Hook Issues

**Problem**: Pre-commit hook blocks commits unexpectedly

**Solutions**:
1. Check current drift status: `openlore drift`
2. Lower the fail threshold: edit the hook to use `--fail-on error` instead of `--fail-on warning`
3. Temporarily bypass: `git commit --no-verify` (use sparingly)
4. Remove the hook: `openlore drift --uninstall-hook`

### Drift Not Detecting Changes

**Problem**: Changed code but no drift reported

**Possible causes**:
1. Changes are on the same branch as the base ref
2. The changed files don't map to any spec domain
3. The spec was updated alongside the code

**Debug**: Run with `--verbose` to see what's being analyzed:
```bash
openlore drift --verbose
```

## Integration Issues

### Existing OpenSpec Conflict

**Problem**: openlore overwrites existing specs

**Solution**: The tool should backup existing files, but you can also:
```
/openlore
Do not overwrite existing specs. Only create new ones.
```

### Config.yaml Conflicts

**Problem**: openlore changes break existing config

**Solution**: Review changes before accepting:
```
/openlore
Show me what you would add to config.yaml before making changes.
```

## Getting Help

### Debug Mode

Set `DEBUG=1` for stack traces on errors:
```bash
DEBUG=1 openlore generate
```

### Still Stuck?

1. **Check the docs**:
   - [Philosophy](./PHILOSOPHY.md) — Understanding the approach
   - [OpenSpec Format](./OPENSPEC-FORMAT.md) — Format reference
   - [Architecture](./ARCHITECTURE.md) — Internal design
   - [OpenSpec Integration](./OPENSPEC-INTEGRATION.md) — Ecosystem integration

2. **File an issue** on [GitHub](https://github.com/clay-good/openlore/issues):
   - Include: Project type, error message, relevant code structure, Node.js version
   - Don't include: Sensitive code, API keys, or credentials

3. **Try manual approach**:
   - Use the spec format reference
   - Write specs manually for problematic areas
   - Let openlore handle the clearer parts

## Known Limitations

1. **Language Support**
   - Best: JavaScript/TypeScript
   - Good: Python
   - Basic: Go, Rust, Java
   - Limited: Other languages

2. **Framework Detection**
   - Well-supported: Express, NestJS, FastAPI, Django
   - Partial: Many others
   - Detection is heuristic-based

3. **Complex Architectures**
   - Microservices: May need per-service runs
   - Monorepos: Focus on specific packages
   - Plugin systems: May miss dynamic behavior

4. **Dynamic Behavior**
   - Runtime configuration not detected
   - Reflection/metaprogramming may be missed
   - Database-driven logic not captured
