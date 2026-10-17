# Plugin Lifecycle frontend

The frontend for the RHDH Plugin Lifecycle POC adds a **Lifecycle** tab to
Software Catalog overlay-workspace `Component` entities. It reads the backend
context API and renders the current or historical lifecycle projection, event
evidence, provenance, and the associated Extensions Catalog `Plugin` and
`Package` metadata.

The package uses the Backstage frontend system and also exports
`EntityPluginLifecycleContent` through its native frontend system extension so it can be mounted
by an existing RHDH frontend. It also ships the compatible legacy frontend
entrypoint (`./legacy`) and `Legacy` Scalprum module for RHDH deployments that
still run the older frontend system. Both entrypoints use the same API client
and backend contract. It uses Backstage/RHDH UI components and the standard
Catalog entity-page extension points; it does not create a separate
application shell.

The accompanying [`app-config.dynamic.yaml`](./app-config.dynamic.yaml)
contains the legacy entity-tab and card mount configuration. The dynamic plugin
packager includes this file alongside the generated `PluginRoot` and `Legacy`
Scalprum modules.

## Development

From this workspace, run `yarn start` to use the generated development app and
backend entrypoints. The isolated frontend development entrypoint is in
[`dev/index.tsx`](./dev/index.tsx).

The dynamic-plugin build is produced by `yarn export-dynamic` at the workspace
root. The resulting frontend package can be installed by RHDH's dynamic plugin
loader.
