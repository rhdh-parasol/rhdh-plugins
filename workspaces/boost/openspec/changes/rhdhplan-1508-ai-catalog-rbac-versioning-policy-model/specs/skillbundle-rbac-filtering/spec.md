# SkillBundle RBAC Filtering

> Read-time permission-based filtering of bundle skill lists.
> Sub-issue: RHDHPLAN-1656

SkillBundle detail views MUST filter their contained skill lists at read time
based on the current viewer's permissions. A user who lacks
`ai-catalog.asset.access` for a skill MUST NOT see that skill listed in any
bundle, regardless of how the bundle was created.

## ADDED Requirements

### Requirement: Read-time skill filtering in bundles

When a user retrieves a bundle detail view, the backend MUST filter out any
skills the user lacks `ai-catalog.asset.access` permission for.

#### Scenario: Mixed-permission bundle view

- **WHEN** a user retrieves a bundle that contains skills A, B, and C
- **AND** the user has `ai-catalog.asset.access` for skills A and C but not
  skill B
- **THEN** the response includes skills A and C
- **AND** skill B is absent from the response

#### Scenario: Full-access bundle view

- **WHEN** a user retrieves a bundle and has `ai-catalog.asset.access` for all
  contained skills
- **THEN** the response includes all skills in the bundle

#### Scenario: No-access bundle view

- **WHEN** a user retrieves a bundle and lacks `ai-catalog.asset.access` for
  all contained skills
- **THEN** the response returns an empty skill list for that bundle

### Requirement: Filtering at backend, not at storage time

Skill filtering in bundles MUST be applied at the backend API layer at read
time, not at bundle-creation or bundle-storage time in Neo4j.

#### Scenario: Bundle storage is permission-agnostic

- **WHEN** an admin creates or updates a SkillBundle in Neo4j
- **THEN** all skills are stored in the bundle regardless of any user's current
  permissions
- **AND** filtering is applied only when a user retrieves the bundle

### Requirement: Consistent filtering across bundle surfaces

Bundle skill filtering MUST be consistent whether the bundle data comes from
the Neo4j API layer or the Catalog API.

#### Scenario: Same filtering for Neo4j and Catalog sources

- **WHEN** a user retrieves the same bundle via the Neo4j-backed API and via
  the Catalog
- **THEN** both responses show the same filtered skill list for that user
