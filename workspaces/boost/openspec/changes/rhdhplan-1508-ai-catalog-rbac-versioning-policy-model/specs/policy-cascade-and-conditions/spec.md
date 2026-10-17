# Policy Cascade and Conditions

> **Status: Draft** — Asset-version policy cascade, conditional rules,
> default-policy configuration, and multi-tenant filtering.

**Jira:** RHDHPLAN-1654

This capability covers the policy evaluation logic that governs how AI Catalog
permissions are resolved across asset versions, conditional scopes, and tenant
boundaries.

## ADDED Requirements

### Requirement: Asset-level policy cascades to versions

A policy applied at the asset level (matched by the shared asset identifier)
MUST govern all version-entities of that asset that do not have a
version-specific override.

#### Scenario: Asset policy governs all versions

- **WHEN** an admin grants `ai-catalog.asset.access` for an asset identified by
  its shared asset identifier
- **AND** no version-specific override exists for any version of that asset
- **THEN** all version-entities of that asset are governed by the asset-level
  policy

#### Scenario: Version-specific override takes precedence

- **WHEN** an admin creates a version-specific policy for a particular version
  (matched by asset identifier plus `rhdh.io/ai-asset-version`)
- **AND** an asset-level policy also exists for the same asset
- **THEN** the version-specific policy takes precedence for that version
- **AND** other versions of the same asset continue to use the asset-level
  policy

#### Scenario: Version-specific override with no asset-level policy

- **WHEN** an admin creates a version-specific policy for a particular version
  (matched by asset identifier plus `rhdh.io/ai-asset-version`)
- **AND** no asset-level policy exists for the parent asset
- **THEN** the version-specific policy governs only that version
- **AND** sibling versions of the same asset fall back to the global
  `defaultPolicy` setting

### Requirement: Category-scoped conditional policies

Conditional policies for AI Catalog permissions MUST support filtering by
`rhdh.io/ai-asset-category` using the `isAiAssetCategory` rule.

#### Scenario: Policy scoped to a specific category

- **WHEN** an admin creates a conditional policy granting
  `ai-catalog.asset.access` with a condition using `isAiAssetCategory`
  set to `ai-skill`
- **THEN** only assets with category `ai-skill` are governed by that policy
- **AND** assets with other categories are unaffected

### Requirement: Connector-scoped conditional policies

Conditional policies for AI Catalog permissions MUST support filtering by
source connector using the `isFromConnector` rule.

#### Scenario: Policy scoped to a connector source

- **WHEN** an admin creates a conditional policy with a condition using
  `isFromConnector` set to `ogx`
- **THEN** only assets ingested from the OGX connector are governed by that
  policy
- **AND** assets from other connectors are unaffected

### Requirement: Tenant-scoped conditional policies

Conditional policies for AI Catalog permissions MUST support filtering by
tenant identity using the `isInTenant` rule.

#### Scenario: Multi-tenant filtering without re-ingestion

- **WHEN** two teams have different conditional policies using `isInTenant`
- **THEN** each team sees only the assets permitted by their tenant-scoped
  policy
- **AND** the entity-provider connectors are not required to ingest separate
  copies of entities per tenant

### Requirement: Existing condition types remain available

Conditional policies for `ai-catalog.asset.access` and
`ai-catalog.asset.access.usage-docs` MUST support the same condition types
already available for catalog permissions (owner-based, namespace/label-based).

#### Scenario: Owner-based conditional policy

- **WHEN** an admin creates a conditional policy for `ai-catalog.asset.access`
  with an ownership condition
- **THEN** only assets owned by the specified group are governed by that policy

### Requirement: Default-policy configuration

An admin-configurable setting MUST determine whether newly-ingested AI asset
entities are visible by default or hidden until a policy is created.

#### Scenario: Default-deny posture

- **WHEN** the `defaultPolicy` setting is set to `deny`
- **AND** a new AI asset entity is ingested with no explicit policy
- **THEN** that asset is not visible to any user without an explicit grant

#### Scenario: Default-allow posture

- **WHEN** the `defaultPolicy` setting is set to `allow`
- **AND** a new AI asset entity is ingested with no explicit policy
- **THEN** that asset is visible to users with general `ai-catalog.asset.access`
  grants

#### Scenario: Default ships as deny

- **WHEN** no administrator has configured the `defaultPolicy` setting
- **THEN** the effective default is `deny`

#### Scenario: Setting gated by ai-catalog.admin

- **WHEN** a user without `ai-catalog.admin` permission attempts to change the
  `defaultPolicy` setting
- **THEN** the change is rejected

### Requirement: Per-category default-policy settings

The default-policy configuration MUST support per-category and per-connector
default postures, not just a single global setting.

#### Scenario: Category-specific default posture

- **WHEN** an SMP Admin sets a default-deny posture for `ai-skill` category
  and default-allow for `mcp-server` category
- **THEN** newly-ingested skills default to hidden and newly-ingested MCP
  servers default to visible
