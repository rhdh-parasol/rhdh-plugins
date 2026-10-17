# AI Catalog RBAC Admin UI

> **Status: Draft** — Dedicated RBAC admin section for the SMP Admin persona.

**Jira:** RHDHPLAN-1655

The RHDH RBAC admin UI MUST provide a dedicated section for AI Catalog policy
management, accessible to users with `ai-catalog.admin`. This section enables
the SMP Admin persona to manage visibility policies without writing raw policy
YAML.

## ADDED Requirements

### Requirement: Dedicated AI Catalog policy section

The RBAC admin UI MUST include a dedicated section for managing AI Catalog
permissions, accessible via the existing RBAC admin navigation.

#### Scenario: SMP Admin accesses the section

- **WHEN** a user with `ai-catalog.admin` navigates to the RBAC admin UI
- **THEN** a dedicated AI Catalog policy management section is available
- **AND** the section is integrated into the existing RBAC admin navigation

#### Scenario: Non-admin user denied access

- **WHEN** a user without `ai-catalog.admin` navigates to the RBAC admin UI
- **THEN** the AI Catalog policy management section is not visible or accessible

### Requirement: Per-skill policy management

The admin section MUST allow setting visibility policies scoped to an individual
skill or AI asset.

#### Scenario: Admin sets policy for a specific skill

- **WHEN** an SMP Admin selects a specific AI asset in the admin section
- **AND** sets a visibility policy for that asset
- **THEN** the policy is created and applied without requiring raw YAML editing

### Requirement: Per-category policy management

The admin section MUST allow setting visibility policies scoped to an asset
category (e.g. all `ai-skill` entities).

#### Scenario: Admin sets policy for a category

- **WHEN** an SMP Admin selects a category (e.g. `ai-skill`) in the admin
  section
- **AND** sets a visibility policy for that category
- **THEN** a conditional policy using `isAiAssetCategory` is created

### Requirement: Per-connector policy management

The admin section MUST allow setting visibility policies scoped to a source
connector.

#### Scenario: Admin sets policy for a connector

- **WHEN** an SMP Admin selects a source connector (e.g. `ogx`) in the admin
  section
- **AND** sets a visibility policy for that connector
- **THEN** a conditional policy using `isFromConnector` is created

### Requirement: Default-policy configuration in admin UI

The admin section MUST expose the default-policy setting (allow/deny) for
newly-ingested assets, including per-category overrides.

#### Scenario: Admin configures default-deny

- **WHEN** an SMP Admin changes the default policy from `allow` to `deny` in
  the admin section
- **THEN** the configuration is persisted
- **AND** newly-ingested assets without explicit policies default to hidden
