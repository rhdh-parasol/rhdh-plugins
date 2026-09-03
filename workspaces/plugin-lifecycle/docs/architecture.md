# RHDH Plugin Delivery Context Architecture

## Document status

This is the target architecture for the Plugin Delivery Context proof of
concept. The repository contains the event store, projection logic, Actions
Registry actions, shared MCP Actions integration, bounded GitHub refresh, and
frontend surfaces for both NFS and legacy RHDH deployments. The lifecycle subject is an overlay workspace
Component, associated with source, Extension Plugin, and Package entities.

The detailed, ordered implementation specification is in
[`implementation-plan.md`](implementation-plan.md).

## 1. The problem

An RHDH plugin is represented by several records that answer different
questions:

| Record              | Question it answers                                          |
| ------------------- | ------------------------------------------------------------ |
| Source Component    | Where is the source code and who owns it?                    |
| Overlay Component   | Where is it exported, tested, and published for RHDH?        |
| Extension Plugin    | How is the plugin presented as an RHDH capability?           |
| Extension Package   | Which package/version/artifact can RHDH install?             |
| GitHub workflow job | What happened during a particular build attempt?             |
| Lifecycle change    | What is the complete, durable story for one delivery change? |

No single existing record provides the complete story. A GitHub Actions tab can
show current repository runs, but it cannot reliably answer which matrix job
belongs to a workspace, which Package was published, what the state was at an
earlier time, or what evidence an agent should use for a go/no-go decision.

The POC adds the lifecycle change and joins it to the other records.

## 2. How plugin data reaches RHDH

RHDH exposes these entities through one Backstage Catalog API, but they arrive
through two ingestion paths.

```text
GitHub entity providers
  |
  +-- rhdh-plugins/catalog-info.yaml
  |     -> source repository/workspace Components
  |
  +-- rhdh-plugin-export-overlays/catalog-info.yaml
        -> overlay repository/workspace Components

Catalog-index / Extensions integration
  |
  +-- catalog-entities/extensions/plugins/*.yaml
  |     -> Extension Plugin entities
  |
  +-- workspaces/*/metadata/*.yaml + build metadata
        -> Extension Package entities with version and OCI artifact

                         one Catalog API
                               |
                               v
                  Plugin Delivery Context backend
```

The `/catalog` and `/extensions` pages are different views of different entity
models. This does not require the lifecycle backend to invent a second entity
database or ingest Extension YAML through the GitHub Component provider.

## 3. What issue #1 establishes

Issue #1 provides the missing Software Catalog foundation for the overlay
repository.

Before that work:

- `rhdh-plugins` contributes source Components;
- the catalog-index contributes Extension Plugin and Package entities;
- overlay workspaces have build metadata and workflows but no Software Catalog
  Component.

The issue adds:

```text
Component: rhdh-plugin-export-overlays
  type: repository
  |
  +-- Component: overlay-<workspace>
        type: rhdh-overlay-workspace
        subcomponentOf: rhdh-plugin-export-overlays
        dependsOn: matching source Component, when one exists
```

It also enables the existing GitHub Actions frontend plugin. That tab is useful
for a human looking at repository-wide workflow runs, but every overlay
Component points to the same repository and therefore sees the same list. It
does not provide per-workspace durable status.

Issue #1 is therefore the entity and navigation foundation. The lifecycle POC
builds the durable per-workspace delivery context on top of it.

## 4. Entity association model

For this use case, the overlay workspace Component is the lifecycle subject.

```text
Lifecycle change (UUID)
  |
  +-- subject/overlay --> component:default/overlay-global-header
  |
  +-- source ----------> component:default/red-hat-developer-hub-global-header
  |
  +-- extension-plugin -> plugin:rhdh/global-header
  |
  +-- package ---------> package:rhdh/red-hat-developer-hub-backstage-plugin-global-header
```

The association is explicit. Generated overlay Component metadata records the
workspace, source repository/ref, verified source Component, Extension Plugin
refs, and Package refs. The backend validates these refs through the Catalog
and stores them with the change.

A user or agent can request context using any associated ref and reach the same
change history. An action caller cannot supply arbitrary associations.

Some overlay workspaces use external source repositories that are not in this
RHDH Software Catalog. In that case, the source repository URL and commit remain
external lifecycle references. The generator does not invent a source
Component.

## 5. Lifecycle identity

The lifecycle backend generates a UUID `changeId` for every lifecycle change.

The UUID remains stable while the change moves through intent, implementation,
build attempts, verification, and publication. A Jira issue, PR, workflow run,
job, Package, or OCI digest is evidence attached to the change.

The GitHub collector also calculates a deterministic external key:

```text
PR build:
github:<overlay-repository>:pr:<number>:workspace:<workspace>

Non-PR build:
github:<overlay-repository>:ref:<branch>:commit:<head-sha>:workspace:<workspace>
```

This lets repeated refreshes and repeated workflow attempts find the same change
without making the GitHub run ID the lifecycle identity.

## 6. Write and read paths

```text
Write path
==========

GitHub App                         Fixture / authenticated action
   |                                           |
   v                                           v
Bounded bootstrap / on-demand refresh    Lifecycle domain service
   |                                           |
   +--------------- normalized events --------+
                           |
                           v
                  PostgreSQL event store
                    |              |
                    |              +-- append-only history
                    +----------------- current projection


Read path
=========

Catalog Lifecycle tab     REST     Actions Registry     MCP client
          |                 |              |                 |
          +-----------------+--------------+-----------------+
                                    |
                                    v
                         Lifecycle context service
                            |                 |
                            v                 v
                     PostgreSQL          Catalog API
```

GitHub and registry access is allowed only on the write/ingestion side. A
context read never waits for GitHub, CI, Jira, a scanner, or an OCI registry.

## 7. Events and projections

Lifecycle events are append-only normalized facts. Examples include:

- change created;
- reference linked;
- phase updated;
- CI job snapshot recorded;
- verification recorded;
- artifact recorded;
- agent attempt recorded;
- change superseded.

After inserting an event, the backend replays the change's events ordered by
occurrence time and database ID and updates the current projection in the same
transaction.

The projection contains the current phase/state, references, attempts,
verifications, artifacts, and the winning run. It is a cache that can always be
reconstructed from events.

An `asOf` request replays only events that occurred at or before the requested
time. This is how the UI can show the failed verification state even after the
current change has reached successful publication.

## 8. GitHub and artifact ingestion

The bootstrap/refresh collector uses the GitHub App's backend credentials. It lists
configured workflow runs and jobs, extracts an exact
`workspaces/<workspace>` segment from each matrix job name, and resolves the
corresponding overlay Component.

For an on-demand refresh, PR evidence is collected before the more expensive
workflow-job scan so the response can expose open and recently closed changes
even when mainline history is still being fetched. For a processable job, it:

1. creates or retrieves the lifecycle change using the deterministic external
   key;
2. records PR, source, workflow, run, and job references;
3. records a CI snapshot and explicit build phase;
4. discovers open PRs plus a bounded recent window of closed PRs, reads the
   exact `published-exports-pr-<number>` artifact after a successful publish
   check when it is still retained, and classifies each PR as open, merged, or
   closed;
5. reads Extensions Catalog Package entities as the released customer-
   installable baseline.

The UI and API keep these facts separate: “Available in Extensions Catalog” is
the released baseline, while a PR artifact is a candidate to test. A successful
workflow job or Catalog package does not independently prove deployment to a
customer instance. Expired artifacts are reported as unavailable rather than
reconstructed from image naming conventions.

Missing or ambiguous data is kept as a compact ingestion diagnostic. The
collector does not create guessed associations or guessed changes.

### Optional publication manifest contract

The future attested mode may use `plugin-lifecycle-manifest.json`, a small,
run-scoped JSON file uploaded as a GitHub Actions artifact. The overlay
workflow would create it from the outputs it actually published; it would not
be copied from Extensions Catalog metadata. Version `1` contains the
repository, workflow, run ID/number/attempt, event/ref, head SHA, run URL, and
one entry per exported Package. Each entry contains the workspace, optional
source repository/revision, Package entity ref, package name, version, OCI
reference, and the matching immutable `sha256` digest.

If enabled later, the backend would download only the exact named artifact for
the selected run and attempt, enforce the one-MiB limits, verify the GitHub
artifact digest when present, validate the schema, and check run and Package
identities before persisting normalized artifact facts. Missing or invalid
manifests would leave publication pending. This attestation mode is not a
prerequisite for the current POC, which uses Catalog `dynamicArtifact`.

## 9. Human and agent interfaces

The same domain service backs all interfaces:

- REST context endpoint for the NFS and legacy frontend surfaces;
- `plugin-lifecycle:create-change`;
- `plugin-lifecycle:record-event`;
- `plugin-lifecycle:get-context`;
- `plugin-lifecycle:refresh`;
- the global Backstage MCP Actions server, which exposes those actions as MCP
  tools.

There is no lifecycle-specific MCP server. An MCP client authenticates through
RHDH OAuth/CIMD and acts with the signed-in user's identity and RBAC
permissions.

The collector is an internal system writer and does not use a public human
action. External unattended service-principal access is a later design problem.

## 10. Catalog UI

The Lifecycle tab is a New Frontend System entity-content extension. It appears
on overlay Components and source Components whose Catalog relation points to an
overlay subject.

The page shows:

- a delivery summary with current status, owner, next action, released
  Extensions Catalog packages, open PR candidates, recent merged/closed PR
  history, candidate OCI images, and latest/latest-successful mainline builds;
- current phase and state;
- all changes for the workspace;
- event evidence and producers;
- source-to-artifact provenance;
- related source, Plugin, and Package entities;
- current and historical state.

The UI offers explicit subject refresh and only polls persisted RHDH state while
initial bootstrap reports that the subject is pending/running. A refresh for a
queued subject is promoted ahead of the remaining bootstrap queue, so a user
does not wait for every workspace to finish. Historical mode never polls.
The existing GitHub Actions CI tab remains available for raw repo-wide runs.

## 11. Data ownership

PostgreSQL stores compact lifecycle context:

- entity refs;
- external IDs;
- URLs;
- phases and states;
- versions and immutable digests;
- normalized attempt and verification summaries.

It does not store workflow logs, ZIP files, screenshots, recordings, container
images, or full agent telemetry. Those remain in their owning systems. An agent
attempt event can link to Fullsend/another execution system without copying its
telemetry.

## 12. Authentication and permissions

Public interfaces require an authenticated user and enforce:

- `plugin-lifecycle.change.read`;
- `plugin-lifecycle.change.create`;
- `plugin-lifecycle.event.create`.

The writer role is assigned to `group:default/rhdh-parasol`. Action visibility
and invocation use the same permission. Catalog lookups use the caller's
credentials.

The GitHub collector uses its own internal writer path and GitHub App token. It
does not grant service credentials access to public actions.

## 13. POC boundaries

Included:

- generated overlay Components;
- explicit source/Plugin/Package associations;
- durable event history and historical replay;
- one-time bounded bootstrap and on-demand GitHub workflow/job refresh;
- Package artifact resolution through the Catalog;
- optional workflow-to-artifact attestation via a later manifest;
- REST, NFS UI, Actions, and MCP;
- PostgreSQL persistence;
- local RHDH validation and gated deployment.

Deferred:

- GitHub webhooks;
- Jira and scanner adapters;
- direct registry polling;
- service-principal agents;
- retention/deletion policy;
- portfolio dashboards;
- modification of the Extensions detail page;
- storage of logs or large artifacts.

## 14. Delivery path

```text
Runtime/version baseline
        |
        v
Overlay Catalog foundation
        |
        v
Generic durable fixture-driven vertical slice
        |
        v
Live GitHub + Package artifact ingestion
        |
        v
RHDH Local + PostgreSQL acceptance
        |
        v
OCI publication + digest-pinned agentic-instance deployment
```

Each stage has an explicit exit gate in the implementation plan. Live or
deployed behavior must not be claimed before its gate passes.
