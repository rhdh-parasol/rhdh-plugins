# Proposal: AI Catalog RBAC & Versioning Policy Model

## Why

The AI Catalog frontend and OGX entity provider ship in RHDH 2.1, but
all AI assets are equally visible to any user with `catalog.entity.read`.
Enterprise customers — particularly in regulated industries — need graduated
visibility (discoverable vs. full usage docs), per-category and per-connector
default-deny posture, asset-to-version policy cascade, and a full audit trail
of RBAC and ingestion changes. RHDHPLAN-1508 delivers the policy model that
controls who can see which AI Catalog assets and at what level of detail.

## What Changes

- **Permission registration**: Three new permissions (`ai-catalog.asset.access`,
  `ai-catalog.asset.access.usage-docs`, `ai-catalog.admin`) are already defined
  in `ai-catalog-common/src/permissions.ts`. This change adds backend
  enforcement and frontend gating for those permissions.
- **Graduated visibility enforcement**: Backend API responses filter fields
  based on the caller's permission tier — tier 1 (discovery metadata only) vs.
  tier 2 (full usage docs, configuration, and connection endpoints).
- **Restricted-access frontend**: UI components render a restricted-access
  placeholder when the caller lacks `ai-catalog.asset.access.usage-docs`,
  replacing usage instructions, configuration snippets, and connection details.
- **Policy cascade**: Asset-level policies (matched by shared asset identifier)
  cascade to all version-entities unless a version-specific override exists.
  Version-specific overrides take precedence.
- **Conditional policy rules**: New condition rules scoped by
  `rhdh.io/ai-asset-category` and source connector, complementing existing
  ownership and namespace conditions. Enables per-category and per-connector
  default postures.
- **Default-policy configuration**: Admin-configurable `defaultPolicy:
  allow|deny` for newly-ingested assets, gated by `ai-catalog.admin`. Ships as
  `deny`.
- **Multi-tenant filtering**: RBAC-time query filtering on a shared entity set
  via conditional policies — no per-tenant re-ingestion required.
- **RBAC admin UI section**: Dedicated section accessible to `ai-catalog.admin`
  holders for managing AI Catalog visibility policies per skill, category, or
  connector.
- **SkillBundle RBAC filtering**: Bundle detail views filter skill lists at
  read time based on the viewer's `ai-catalog.asset.access` permission.
- **Audit log integration**: Two new event categories — RBAC policy changes
  affecting AI asset permissions, and ingestion sync events from entity
  providers.

## Capabilities

### New Capabilities

- `graduated-visibility-enforcement`: Backend enforcement of the two-tier
  permission model — field-level API filtering based on caller's
  `ai-catalog.asset.access` and `ai-catalog.asset.access.usage-docs` grants.
- `restricted-access-frontend`: Frontend restricted-access placeholder
  components shown when the caller lacks usage-docs permission.
- `policy-cascade-and-conditions`: Asset-to-version policy cascade with
  version-specific overrides, conditional rules for category/connector/tenant
  scoping, default-allow/deny configuration, and multi-tenant query filtering.
- `ai-catalog-rbac-admin-ui`: Dedicated RBAC admin UI section for the SMP Admin
  persona to manage AI Catalog visibility policies.
- `skillbundle-rbac-filtering`: Read-time permission-based filtering of bundle
  skill lists at the backend API layer.
- `rbac-audit-integration`: Audit log emission for RBAC policy changes and
  ingestion sync events, viewable in the existing RHDH Audit Log.

### Modified Capabilities

None. The existing `ai-catalog-browse-view`, `ai-catalog-entity-extensions`,
and `ogx-entity-provider` specs describe current release behavior and are not
modified by this change. The new capabilities add authorization enforcement on
top of the existing browse and entity model.

## Canonical Touchpoints

- `openspec/specs/` — No existing long-lived specs are modified.
- `specifications/prd/` — None affected.
- `specifications/adr/` — None affected.
- `openspec/changes/ai-catalog-asset-governance/` — Existing governance change
  covers the same RBAC area with a more conservative, decision-gated approach.
  This change records the full RHDHPLAN-1508 feature requirements; reconciliation
  between the two should happen during implementation planning.

Change type: **feature-spec**

## Impact

- **Packages**: `ai-catalog-common` (permissions already defined),
  `boost-backend` or future RBAC backend module (enforcement logic),
  `ai-catalog` frontend plugin (restricted-access UI), entity provider SDK
  (audit event emission).
- **APIs**: Catalog query responses gain field-level filtering; bundle API
  responses gain skill-level filtering.
- **Dependencies**: RHDH Permission Framework, RBAC plugin, `AuditorService`,
  Neo4j API layer (for SkillBundle filtering).
- **External**: Depends on RHDHPLAN-1507 (AI Asset Entity Model & Ingestion
  Framework) for the `rhdh.io/ai-asset-version` annotation and shared asset
  identifier.

## Sub-issue traceability

| Sub-issue      | Capability                          |
| -------------- | ----------------------------------- |
| RHDHPLAN-1652  | `graduated-visibility-enforcement`  |
| RHDHPLAN-1653  | `restricted-access-frontend`        |
| RHDHPLAN-1654  | `policy-cascade-and-conditions`     |
| RHDHPLAN-1655  | `ai-catalog-rbac-admin-ui`          |
| RHDHPLAN-1656  | `skillbundle-rbac-filtering`        |
| RHDHPLAN-1657  | `rbac-audit-integration`            |
