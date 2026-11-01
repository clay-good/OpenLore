This project uses OpenLore for persistent architectural memory.

Call `orient "<task description>"` (via the openlore MCP server, or
`npx openlore orient --json`) **before touching a module you have not yet read in
this session**, and when a task spans several modules. It returns the relevant
functions, callers, spec sections, and insertion points in one structural lookup
instead of file-by-file rediscovery.

Skip it for work you are already inside: repeated edits to a file you have read
this session do not need re-orientation. Reach for it again when the task moves
to unfamiliar code.

OpenLore prefixes tool responses with a brief, factual freshness note (the
Epistemic Lease) once your cached context has aged or the repo has moved since
your last `orient()`. It is informational — re-`orient()` if you are relying on
cached cross-module structure; otherwise carry on.

When you make a significant design choice, record it:
`openlore decisions record --title "<decision>" --rationale "<why>"` (add
`--files` for the files it governs). Under decision autopilot it is accepted at
once and synced to the specs; the user reviews the trail with
`openlore decisions review`.

For the MCP setup, ensure `openlore mcp` is configured as an MCP server.
See https://github.com/clay-good/OpenLore for details.
