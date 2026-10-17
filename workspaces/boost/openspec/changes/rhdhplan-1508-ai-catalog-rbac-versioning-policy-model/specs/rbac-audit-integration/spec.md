# RBAC Audit Integration

> **Status: Draft** — Audit log emission for RBAC policy changes and ingestion
> sync events.

**Jira:** RHDHPLAN-1657

Two new categories of AI-Catalog-relevant events MUST be emitted to the
existing RHDH Audit Log via `AuditorService`: RBAC policy changes affecting AI
asset permissions, and entity-provider ingestion sync events.

## ADDED Requirements

### Requirement: RBAC policy change audit events

Creating, modifying, or deleting any conditional policy that references
`ai-catalog.asset.access`, `ai-catalog.asset.access.usage-docs`, or
`ai-catalog.admin` MUST produce an Audit Log entry.

#### Scenario: Policy creation logged

- **WHEN** an admin creates a new conditional policy granting
  `ai-catalog.asset.access` to a role
- **THEN** an Audit Log entry is created recording the actor, timestamp, the
  policy and role affected, and the policy details

#### Scenario: Policy modification logged

- **WHEN** an admin modifies an existing AI Catalog permission policy
- **THEN** an Audit Log entry is created recording the actor, timestamp, the
  policy affected, and a before/after summary of the change

#### Scenario: Policy deletion logged

- **WHEN** an admin deletes an AI Catalog permission policy
- **THEN** an Audit Log entry is created recording the actor, timestamp, and
  the deleted policy details

### Requirement: Default-policy change audit events

Changing the `defaultPolicy` setting MUST produce an Audit Log entry.

#### Scenario: Default policy changed

- **WHEN** an SMP Admin changes the `defaultPolicy` from `allow` to `deny`
  (or vice versa)
- **THEN** an Audit Log entry is created recording the actor, timestamp, and
  the before/after values

#### Scenario: Per-category default posture changed

- **WHEN** an SMP Admin changes the default posture for a specific asset
  category (e.g. `ai-skill` changed from `allow` to `deny`)
- **THEN** an Audit Log entry is created recording the actor, timestamp, the
  category affected, and the before/after values

#### Scenario: Per-connector default posture changed

- **WHEN** an SMP Admin changes the default posture for a specific connector
  source (e.g. `ogx` changed from `deny` to `allow`)
- **THEN** an Audit Log entry is created recording the actor, timestamp, the
  connector source affected, and the before/after values

### Requirement: Ingestion sync event audit entries

Each entity-provider sync event (asset or version added, updated, or removed)
MUST produce an Audit Log entry.

#### Scenario: Asset ingested

- **WHEN** an entity-provider connector ingests a new AI asset
- **THEN** an Audit Log entry is created recording the connector source, the
  asset identifier, the mutation type (added), and the timestamp

#### Scenario: Asset updated

- **WHEN** an entity-provider connector updates an existing AI asset
- **THEN** an Audit Log entry is created recording the connector source, the
  asset identifier, the mutation type (updated), and the timestamp

#### Scenario: Asset removed

- **WHEN** an entity-provider connector removes or tombstones an AI asset
- **THEN** an Audit Log entry is created recording the connector source, the
  asset identifier, the mutation type (removed), and the timestamp

### Requirement: Audit events viewable in existing UI

AI Catalog audit events MUST be viewable in the existing RHDH Audit Log
UI/export without requiring a separate AI-Catalog-specific audit view.

#### Scenario: Admin filters audit log for AI Catalog events

- **WHEN** an admin opens the RHDH Audit Log viewer
- **THEN** AI Catalog RBAC policy change events and ingestion sync events are
  listed alongside other RHDH audit events
- **AND** the events are filterable by category

### Requirement: Audit event schema

Each audit event MUST include sufficient fields for compliance evidence:
actor, timestamp, event type, affected resource identifier, and mutation
details.

#### Scenario: Event fields for compliance

- **WHEN** an audit event is emitted for an AI Catalog RBAC or ingestion action
- **THEN** the event record includes actor identity, ISO-8601 timestamp, event
  type, affected asset or policy identifier, and a structured mutation summary
