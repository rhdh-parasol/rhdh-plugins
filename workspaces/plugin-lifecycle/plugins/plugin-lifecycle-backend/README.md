# Plugin Lifecycle backend

The backend is the durable context layer for plugin lifecycle data. It stores
append-only normalized events and a current projection in the plugin-owned
PostgreSQL schema, replays events for historical `asOf` reads, and resolves
source Software Catalog `Component` identity together with Extensions Catalog
`Plugin` and `Package` entities.

It exposes:

- authenticated Actions Registry actions for creating changes, recording events,
  and retrieving agent context;
- the authenticated REST context endpoint used by the Catalog tab; and
- the `plugin-lifecycle:get-context` MCP action for agents that can reach RHDH's
  Actions Registry.

The implementation deliberately reads persisted lifecycle data. GitHub, CI,
Jira, registry, and scanner adapters can append the same common event contract
later without making UI/API reads dependent on those systems.

## Installation

Install `@red-hat-developer-hub/backstage-plugin-lifecycle-backend` in an RHDH
backend and add it with the Backstage backend system:

```ts
backend.add(
  import('@red-hat-developer-hub/backstage-plugin-lifecycle-backend'),
);
```

For the POC workspace, use `yarn start` from the workspace root or the backend
development entrypoint in [`dev/index.ts`](./dev/index.ts).
