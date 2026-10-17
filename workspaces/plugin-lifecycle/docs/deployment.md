# Deployment to RHDH

## Publication is deliberately disabled

The current CI workflow verifies and packages both dynamic plugins locally but
does not log in to a registry or publish images. Keep publication disabled until
the POC passes the live acceptance rehearsal.

When publication is explicitly enabled later, publish the frontend and backend
as independent immutable plugin images in the same GHCR repository:

- `ghcr.io/rhdh-parasol/rhdh-plugin-lifecycle:frontend-<git-sha>`
- `ghcr.io/rhdh-parasol/rhdh-plugin-lifecycle:backend-<git-sha>`

Resolve both image digests after the workflow completes. Copy
`examples/rhdh/dynamic-plugins.yaml` into the deployment's `dynamicPlugins`
configuration and replace both digest placeholders. Do not deploy mutable tags.

The frontend supports both RHDH frontend systems. On NFS it loads the default
`PluginRoot` export as a `FrontendPlugin`, and `app.extensions` enables the
`entity-content:plugin-lifecycle/lifecycle` extension. On the legacy frontend it
loads the `Legacy` Scalprum module and the packaged
`app-config.dynamic.yaml` mounts `EntityPluginLifecycleContent` at
`entity.page.lifecycle`. Both entrypoints use the same API client and backend;
the separate Extensions detail route is not changed.

The target RHDH application must have the dynamic frontend feature loader
enabled. If it uses NFS, the NFS app shell and frontend feature loader are
required. If it uses the legacy frontend, the `Legacy` Scalprum assets and the
packaged dynamic configuration provide the entity tab and card mount.

## Enable the shared MCP Actions backend

Do not package or deploy a custom MCP server for Plugin Lifecycle. Install the
global `@backstage/plugin-mcp-actions-backend` dynamic plugin once for the RHDH
instance, then merge this application configuration:

```yaml
backend:
  actions:
    pluginSources:
      - plugin-lifecycle
    filter:
      include:
        - id: 'plugin-lifecycle:get-context'

mcpActions:
  name: RHDH
  description: Query current and historical lifecycle context for Catalog overlay workspace entities.
  instructions: Use plugin-lifecycle.get-context before making plugin release or remediation decisions. Cite lifecycle evidence from the returned context.

pluginLifecycle:
  actions:
    exposeProducerActions: false
    exposeRefreshAction: false
```

The lifecycle action IDs use colons in the Actions Registry. The shared MCP
Actions service is filtered to expose only the read entry point to agents:

- `plugin-lifecycle:get-context` → `plugin-lifecycle.get-context`

The producer and operator actions are not registered by default. A trusted
replay or integration environment may explicitly enable them through
`pluginLifecycle.actions.exposeProducerActions` and
`pluginLifecycle.actions.exposeRefreshAction`. When enabled, they remain
available through the plugin's Actions Registry endpoint but are not
advertised as MCP tools:

- `plugin-lifecycle:create-change` (producer/manual change registration)
- `plugin-lifecycle:record-event` (producer evidence ingestion)
- `plugin-lifecycle:refresh` (explicit operator synchronization)

Use `/api/mcp-actions/v1`; a separate named server is unnecessary for this POC.
The global server applies each action's visibility permission during discovery,
and the lifecycle service enforces the same permission again during invocation.

The development workspace pins `@backstage/plugin-mcp-actions-backend` `0.2.1`,
the version shipped with Backstage `1.54.4`, for local integration tests only.
It is a development dependency and is not embedded in the lifecycle backend
dynamic package. Before deployment, resolve or build an immutable MCP Actions
dynamic-plugin artifact for the exact Backstage version in the target RHDH
image. The checked-in example intentionally uses a digest placeholder because
an older `bs_<backstage-version>__<plugin-version>` wrapper must not be assumed
compatible.

For browser-based agent authentication, RHDH must use the New Frontend System,
load both the auth backend and NFS auth frontend plugins, and enable CIMD:

```yaml
auth:
  clientIdMetadataDocuments:
    enabled: true
```

Configure an OAuth-capable MCP client with only the server URL from
`examples/mcp-client.json`. The login flow yields a user principal, so existing
RHDH RBAC remains authoritative. This POC intentionally rejects service
principals; static external-access MCP tokens are not a substitute for user
OAuth here.

## Register the plugin with RBAC

Include `plugin-lifecycle` in
`permission.rbac.pluginsWithPermission` if that list is explicitly configured
by the RHDH instance. After the backend has registered its permissions, create
the role below through the RHDH RBAC administration UI/API:

```csv
p, role:default/plugin-lifecycle-writer, plugin-lifecycle.change.read, read, allow
p, role:default/plugin-lifecycle-writer, plugin-lifecycle.change.create, create, allow
p, role:default/plugin-lifecycle-writer, plugin-lifecycle.event.create, create, allow
p, role:default/plugin-lifecycle-writer, plugin-lifecycle.sync.run, create, allow
g, group:default/rhdh-parasol, role:default/plugin-lifecycle-writer
```

For the POC, the role is bootstrapped once after deployment. Moving the policy
to GitOps should accompany a future chart-wrapper change.

## Validate

1. Confirm the dynamic-plugin init container installed both package paths.
2. Confirm the backend migration created its plugin database tables.
3. Run `backstage-cli actions list` and verify the default read action is
   visible:
   - `plugin-lifecycle:get-context`
     If producer or operator actions were explicitly enabled for a trusted
     integration, verify those additional actions as well:
   - `plugin-lifecycle:create-change`
   - `plugin-lifecycle:record-event`
   - `plugin-lifecycle:refresh`
     Configure `plugin-lifecycle` as an Actions CLI source first if it has not
     already been registered for the selected instance.
4. Point an authenticated MCP client at `/api/mcp-actions/v1` and verify
   `tools/list` contains `plugin-lifecycle.get-context`. Invoke it for
   `component:default/overlay-global-header` and compare its structured result with the
   Actions CLI result.
   The REST API also accepts
   `/api/plugin-lifecycle/plugins/rhdh/global-header/context` for clients
   that address the Extension Plugin directly.
5. Open `component:default/overlay-global-header` in the Catalog and select **Lifecycle**.
6. Optionally run the legacy fixture replay. Enable both opt-in action flags
   before starting the backend:

   ```yaml
   pluginLifecycle:
     actions:
       exposeProducerActions: true
       exposeRefreshAction: true
   ```

   ```sh
   node demo/replay-lifecycle.mjs --instance <configured-instance-name>
   ```

7. Register a second synthetic overlay `Component` and replay
   `./example-analytics-events.json` with `--fixture` to prove the backend and UI
   contain no Global Header-specific behavior.
8. Restart the RHDH backend pod and verify the change and its historical state
   remain available.

Run the replay with `--dry-run` to inspect the generated CLI calls without
contacting RHDH. Use `--delay-ms 0` for an immediate replay.

For local development only, start the frontend and backend packages and use the
mock-authenticated development endpoint:

```sh
node demo/replay-lifecycle.mjs \
  --local-backend http://localhost:7007 \
  --delay-ms 0
```

`--local-backend` obtains a short-lived guest user token from the local
development backend and must never be used against a deployed RHDH instance.
The default replay path always uses the authenticated Backstage CLI instance.

The MCP protocol smoke test uses the same local restriction:

```sh
node demo/query-lifecycle-mcp.mjs \
  --local-backend http://localhost:7007 \
  --entity-ref component:default/overlay-global-header
```

For a raw remote smoke test, pass the full MCP endpoint with `--server-url` and
place a short-lived authenticated **user** token in `RHDH_MCP_USER_TOKEN`. Do not
put tokens on the command line or commit them. A real agent demo should use an
OAuth-capable MCP client and CIMD instead of manually handling a token.
