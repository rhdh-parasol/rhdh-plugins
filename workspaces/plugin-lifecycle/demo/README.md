# Demo evidence

`global-header-events.json` reconstructs the Global Header 2.0 incident without
adding Global Header behavior to the plugin itself.

Verified external evidence:

- Issue `#3099`, PRs `#3059` and `#3096`
- Fullsend Actions runs `30656004334` and `30679701066`
- RHDH Plugins source commit `aabb85ef001ddae5af621ecf17e02f7bac9175e3`
- Global Header `2.0.0` OCI tag and digest

Explicit synthetic evidence:

- Four E2E attempts whose original GitHub run identifiers were not available
- The final winning-run identifier that connects the verified source SHA to the
  publication projection

Synthetic CI records set `fixture: true`; the UI labels them “Fixture data — not
a real CI run.” Real Actions records set `fixture: false` and link to GitHub.

`example-analytics-events.json` is wholly synthetic and targets a separate
overlay Component. It exists to prove the actions, storage, reducer, historical
queries, and UI are entity-driven rather than Global Header-specific.

`query-lifecycle-mcp.mjs` is a protocol-level smoke test for Backstage's shared
MCP Actions endpoint. It lists tools, verifies that
`plugin-lifecycle.get-context` is visible, invokes it, and prints the structured
context returned by the existing lifecycle action. It does not implement or
connect to a separate lifecycle MCP server.
