# Graduated Visibility Enforcement

> Backend enforcement of the two-tier AI Catalog permission model.
> Sub-issue: RHDHPLAN-1652

The backend MUST enforce graduated visibility using the existing
`ai-catalog.asset.access` and `ai-catalog.asset.access.usage-docs` permissions
defined in `ai-catalog-common/src/permissions.ts`. Users with tier-1 access see
discovery metadata; users with tier-2 access additionally see usage docs,
configuration, and connection endpoints.

## ADDED Requirements

### Requirement: Tier-1 discovery access

A user granted `ai-catalog.asset.access` for a given AI asset MUST see that
asset's name, category, description, owner, tags, lifecycle stage, and version
list in API responses.

#### Scenario: Tier-1 user queries asset list

- **WHEN** a user with `ai-catalog.asset.access` (but not
  `ai-catalog.asset.access.usage-docs`) queries the AI Catalog API
- **THEN** the response includes each permitted asset's name, category,
  description, owner, tags, lifecycle stage, and version list
- **AND** usage instructions, configuration snippets, and connection endpoint
  fields are omitted from the response

### Requirement: Tier-2 full detail access

A user granted both `ai-catalog.asset.access` and
`ai-catalog.asset.access.usage-docs` for a given asset MUST see the full entity
detail including usage/install instructions, configuration snippets, and
connection endpoints.

#### Scenario: Tier-2 user views asset detail

- **WHEN** a user with both `ai-catalog.asset.access` and
  `ai-catalog.asset.access.usage-docs` requests an asset's detail
- **THEN** the response includes all discovery metadata plus usage instructions,
  configuration snippets, and connection endpoints

### Requirement: Denied asset is invisible

A user denied `ai-catalog.asset.access` for a given AI asset entity MUST NOT
see that entity in any AI Catalog surface.

#### Scenario: Denied user searches AI Catalog

- **WHEN** a user without `ai-catalog.asset.access` for an asset queries the
  AI Catalog API (search, browse, or direct link)
- **THEN** the asset is absent from the response

#### Scenario: Denied user accesses asset by direct URL

- **WHEN** a user without `ai-catalog.asset.access` navigates to an asset's
  direct entity page URL
- **THEN** the backend returns a not-found or forbidden response

### Requirement: Field filtering at the API boundary

Field-level filtering MUST be enforced at the backend API response boundary,
not at the frontend rendering layer.

#### Scenario: API response omits protected fields

- **WHEN** the backend constructs a response for a tier-1 user
- **THEN** the protected field group (usage docs, configuration, connection
  endpoints) is removed from the response payload before serialization
- **AND** no protected field data is transmitted to the client

### Requirement: Permission check performance

Adding AI Catalog permission checks to a catalog search/browse request MUST NOT
increase p95 request latency by more than 10% compared to the same request
volume against non-AI-Catalog entities under the existing RBAC plugin.

#### Scenario: Load test within latency budget

- **WHEN** a load test issues catalog search/browse requests against AI Catalog
  entities with permission checks enabled
- **THEN** the p95 latency is within 10% of the baseline p95 measured against
  an equivalent volume of non-AI-Catalog catalog entities
