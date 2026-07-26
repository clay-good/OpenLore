## Interactive Graph Viewer

`openlore view` launches a local React app that visualises your codebase analysis and lets you explore spec requirements side-by-side with the dependency graph.

```bash
# Run analysis first (if not already done)
openlore analyze

# Launch the viewer (opens browser automatically)
openlore view

# Options
openlore view --port 4000          # custom port (default: 5173)
openlore view --host 127.0.0.1     # loopback only; a non-loopback host needs
                                  # --allow-remote-unauthenticated (the page carries the token)
openlore view --no-open            # don't open browser automatically
openlore view --analysis <path>    # custom analysis dir (default: .openlore/analysis/)
openlore view --spec <path>        # custom spec dir (default: ./openspec/specs/)
```

### Views

| View | Description |
|------|-------------|
| **Clusters** | Colour-coded architectural clusters with expandable member nodes. Falls back to directory clusters for languages without import edges (Swift, C++) |
| **Flat** | Force-directed dependency graph (all nodes). Import edges are solid; call edges (Swift/C++ synthesised, or HTTP cross-language) are cyan dashed |
| **Classes** | Class/struct inheritance and call graph. Nodes coloured by language or connected component; isolated nodes hidden. Component-aware force layout keeps related classes together |
| **Architecture** | High-level cluster map: role-coloured boxes, inter-cluster dependency arrows |
| **Classes** | Component-aware force layout of class/struct relationships with coloured groupings |

### Diagram Chat

The right sidebar includes a **Diagram Chat** panel powered by an LLM agent. The chat can access all analysis tools and interact with the graph:

- Ask questions about your codebase in natural language
- Graph functions and requirements mentioned in answers are automatically highlighted
- Clusters containing highlighted nodes auto-expand to reveal the nodes
- Select a node in the chat to view its details tab

Example queries:
- "What are the most critical functions?"
- "Where would I add a new API endpoint?"
- "Show me the impact of changing the authentication service"

The chat requires an LLM API key (same provider configuration as `openlore generate`). Viewer-only operations like graph browsing, skeleton view, and search do not require an API key.

### Right panel tabs (select a node to activate)

| Tab | Content |
|-----|---------|
| **Node** | File metadata: exports, language, score |
| **Links** | Direct callers and callees |
| **Blast** | Downstream impact radius |
| **Spec** | Requirements linked to the selected file -- body, domain, confidence |
| **Skeleton** | Noise-stripped source: logs and comments removed, structure preserved |
| **Info** | Global stats and top-ranked files |

### Search

The search bar filters all three views simultaneously (text match on name, path, exports, tags). If a vector index was built with `--embed`, typing >= 3 characters also queries the semantic index and shows the top 5 function matches in a dropdown.

### Automatic data loading

The viewer auto-loads all available data on startup:

| Endpoint | Source | Required? |
|----------|--------|-----------|
| `/api/dependency-graph` | `.openlore/analysis/dependency-graph.json` | Yes |
| `/api/llm-context` | `.openlore/analysis/llm-context.json` | No |
| `/api/refactor-priorities` | `.openlore/analysis/refactor-priorities.json` | No |
| `/api/mapping` | `.openlore/analysis/mapping.json` | No |
| `/api/spec-requirements` | `openspec/specs/**/*.md` + `mapping.json` | No |
| `/api/skeleton?file=` | Source file on disk | No |
| `/api/search?q=` | `.openlore/analysis/vector-index/` | No (`--embed`) |

Run `openlore generate` to produce `mapping.json` and the spec files. Once present, the **Spec** tab shows the full requirement body for each selected file.

### View Options

```bash
openlore view [options]
  --analysis <path>    Analysis directory (default: .openlore/analysis/)
  --spec <path>        Spec files directory (default: ./openspec/specs/)
  --port <n>           Port (default: 5173)
  --host <host>        Loopback bind host (default: 127.0.0.1)
  --no-open            Skip automatic browser open
```

