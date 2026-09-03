# RHDH Plugin Lifecycle

Plugin Lifecycle is intended to turn Red Hat Developer Hub into the durable
context layer for plugin delivery changes. Producers append normalized events
once; people and agents read the same current or historical state without
querying GitHub, CI, Jira, or registries on every request.

The implementation is keyed by a durable lifecycle subject for an overlay
workspace Component. It explicitly associates that subject with its source
Component, Extension Plugin, and Package entities. Regression fixtures are
test-only and are not loaded by the example app.

See [`docs/architecture.md`](docs/architecture.md) for the target architecture
and [`docs/implementation-plan.md`](docs/implementation-plan.md) for the
decision-complete, gated implementation plan.

## Packages

- `@red-hat-developer-hub/backstage-plugin-lifecycle-common` — contracts and permissions
- `@red-hat-developer-hub/backstage-plugin-lifecycle-backend` — event store, projections,
  read API, and Actions Registry actions
- `@red-hat-developer-hub/backstage-plugin-lifecycle` — New Frontend System and
  legacy Catalog entity-content extensions built with Backstage UI; the package
  exposes both `PluginRoot` and `Legacy` Scalprum modules

## Local verification

```sh
corepack yarn install --immutable
corepack yarn tsc
corepack yarn test
corepack yarn build
corepack yarn export-dynamic
corepack yarn package-dynamic
```

Set `LIFECYCLE_POSTGRES_URL` while running `yarn test` to enable the PostgreSQL
integration suite. The remaining repository tests use SQLite for speed.

## Run the POC locally

The workspace contains a complete Backstage CLI-scaffolded example app and
backend. The app uses the New Frontend System and reads real Catalog metadata from the
current `rhdh-plugins` checkout plus a sibling `rhdh-plugin-export-overlays`
checkout. Extension Plugin and Package entities come from the overlay
checkout, while lifecycle evidence comes from GitHub and the persisted plugin
database.

With both repositories checked out under the same parent directory, run:

```sh
corepack yarn start
```

The Catalog reads the source, overlay, Plugin, and Package YAML directly from
those checkouts. The backend enables bounded GitHub Actions collection and
per-plugin refresh using the configured GitHub App/integration credentials;
normal context reads remain database-backed.

## Agent access through the shared RHDH MCP server

This repository does not implement a lifecycle-specific MCP server. The backend
registers ordinary Actions Registry actions, and Backstage's global
`mcp-actions` backend exposes those same handlers as namespaced MCP tools:

- `plugin-lifecycle.create-change`
- `plugin-lifecycle.record-event`
- `plugin-lifecycle.get-context`

The local development backend boots the shared server at
`http://localhost:7007/api/mcp-actions/v1`. With the backend running, verify
discovery and invoke the context tool over the MCP protocol:

```sh
node demo/query-lifecycle-mcp.mjs \
  --local-backend http://localhost:7007 \
  --entity-ref component:default/overlay-global-header
```

For an RHDH deployment, enable the global `mcp-actions` dynamic plugin once and
add `plugin-lifecycle` to `backend.actions.pluginSources`. Point an OAuth-capable
MCP client at `https://<rhdh-host>/api/mcp-actions/v1`; a starter client entry is
checked in at [`examples/mcp-client.json`](examples/mcp-client.json). With CIMD
enabled, the client completes browser-based RHDH login and invokes tools with
the signed-in user's identity and RBAC permissions.

This POC deliberately requires a human user principal, including for MCP calls.
It therefore supports an agent acting for an authenticated user, but not an
unattended service principal. Static external-access tokens identify services
and are rejected by the lifecycle service. Service-principal policy and scoped
machine authentication remain follow-on work.

## RHDH configuration

See [`docs/deployment.md`](docs/deployment.md) for the current dynamic-plugin
and RBAC configuration. The backend performs one bounded initial collection
when configured and then refreshes a single subject only on demand. Context
reads use PostgreSQL and the Catalog API; they never call GitHub or a registry.
Refresh requests wait up to 30 seconds by default, then return the persisted
context while a longer collection continues in the background. Tune this with
`pluginLifecycle.refreshWaitTimeoutMs`; the backend caps the value at 60 seconds.
OCI publication and external deployment remain gated on the complete RHDH Local
acceptance suite.

When GitHub collection is enabled, configure overlay repositories under
`pluginLifecycle.githubActions.repositories` (or the backwards-compatible
single `repository` key). Repository identity is otherwise taken from each
overlay Component's `github.com/project-slug` annotation; the plugin contains
no built-in repository or plugin allowlist. Each collection also imports a
bounded recent window of closed pull requests (up to three per workspace by
default) so a new RHDH instance can show completed/merged changes. Tune this
with `pluginLifecycle.githubActions.closedPullRequestsPerWorkspace` or set it
to `0` to disable the closed-PR lookup. The repository-wide scan is capped at
100 recent PRs. Closed changes remain in history and are never shown as active
candidates.
