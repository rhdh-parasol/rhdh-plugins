# Tasks: AI Catalog RBAC & Versioning Policy Model

## 1. Permission Registration & Backend Enforcement (RHDHPLAN-1652)

- [ ] 1.1 Verify permission definitions in `ai-catalog-common/src/permissions.ts` are complete and exported (`ai-catalog.asset.access`, `ai-catalog.asset.access.usage-docs`, `ai-catalog.admin`, resource type `ai-catalog-asset`)
- [ ] 1.2 Implement backend permission evaluation for `ai-catalog.asset.access` in AI Catalog API endpoints — deny access to assets where the caller lacks this permission
- [ ] 1.3 Implement field-level filtering at the API response boundary — strip usage docs, configuration snippets, and connection endpoint fields when the caller lacks `ai-catalog.asset.access.usage-docs`
- [ ] 1.4 Implement `ai-catalog.admin` gate for management actions (connector config, default-policy setting, skill curation)
- [ ] 1.5 Write automated tests: create a role without `ai-catalog.asset.access` and confirm the asset is absent from API responses; create a role with tier-1 only and confirm protected fields are omitted
- [ ] 1.6 Run p95 latency benchmark comparing AI Catalog permission checks against equivalent non-AI-Catalog entity volume; confirm < 10% regression

## 2. Frontend Restricted-Access UI (RHDHPLAN-1653)

- [ ] 2.1 Create a reusable `RestrictedAccessPlaceholder` component following the Augment Plugin security gate UI pattern
- [ ] 2.2 Integrate the placeholder into the AI asset entity detail page — gate usage instructions, configuration snippets, and connection endpoint sections behind `ai-catalog.asset.access.usage-docs` using `RequirePermission`
- [ ] 2.3 Add a message in the placeholder directing the user to request access or contact the asset owner
- [ ] 2.4 Write frontend unit tests verifying placeholder renders for tier-1 users and full content renders for tier-2 users

## 3. Policy Cascade & Conditional Rules (RHDHPLAN-1654)

- [ ] 3.1 Implement the `isAiAssetCategory` conditional rule — match AI catalog assets by `rhdh.io/ai-asset-category` annotation
- [ ] 3.2 Implement the `isFromConnector` conditional rule — match AI catalog assets by `rhdh.io/ai-asset-source` annotation
- [ ] 3.3 Implement the `isInTenant` conditional rule — match by namespace or `rhdh.io/ai-asset-tenant` annotation
- [ ] 3.4 Implement asset-to-version policy cascade: evaluate version-specific policies first (matched by asset identifier plus `rhdh.io/ai-asset-version`), fall back to asset-level policy (matched by shared asset identifier)
- [ ] 3.5 Implement default-policy configuration (`permission.rbac.aiCatalog.defaultPolicy: allow|deny`) with `deny` as default; gate setting changes behind `ai-catalog.admin`
- [ ] 3.6 Implement per-category and per-connector default-policy overrides
- [ ] 3.7 Write automated conditional-policy tests: category-scoped, connector-scoped, tenant-scoped, and ownership-based policies
- [ ] 3.8 Write automated cascade tests: asset-level policy governs all versions; version-specific override takes precedence

## 4. RBAC Admin UI Section (RHDHPLAN-1655)

- [ ] 4.1 Add a dedicated AI Catalog policy management section to the existing RBAC admin UI, gated by `ai-catalog.admin`
- [ ] 4.2 Implement per-skill policy management UI (select an AI asset, set visibility policy)
- [ ] 4.3 Implement per-category policy management UI (select a category, create conditional policy using `isAiAssetCategory`)
- [ ] 4.4 Implement per-connector policy management UI (select a connector, create conditional policy using `isFromConnector`)
- [ ] 4.5 Expose default-policy configuration (allow/deny) in the admin UI with per-category override support
- [ ] 4.6 Write frontend tests for admin UI section visibility (admin vs. non-admin) and policy creation flows

## 5. SkillBundle RBAC Filtering (RHDHPLAN-1656)

- [ ] 5.1 Implement read-time skill filtering in the bundle detail API — filter out skills the current user lacks `ai-catalog.asset.access` for
- [ ] 5.2 Ensure filtering is applied at the backend API layer, not at Neo4j storage time
- [ ] 5.3 Write automated test: bundle with mixed-permission skills returns only permitted skills to a tier-1 user

## 6. Audit Log Integration (RHDHPLAN-1657)

- [ ] 6.1 Emit audit events via `AuditorService` for RBAC policy changes affecting `ai-catalog.asset.access`, `ai-catalog.asset.access.usage-docs`, and `ai-catalog.admin` — record actor, timestamp, policy/role, and before/after summary
- [ ] 6.2 Emit audit events via `AuditorService` for default-policy setting changes — record actor, timestamp, and before/after values
- [ ] 6.3 Emit audit events via `AuditorService` for entity-provider ingestion sync events (asset/version added, updated, removed) — record connector source, asset identifier, mutation type, and timestamp
- [ ] 6.4 Verify audit events are viewable and filterable in the existing RHDH Audit Log UI
- [ ] 6.5 Write automated tests for audit event emission (RBAC changes and ingestion sync events)

## 7. Documentation & Validation

- [ ] 7.1 Document the three AI Catalog permissions and the graduated visibility model in the RHDH RBAC plugin administration guide
- [ ] 7.2 Create a worked example: admin creates tier-1 and tier-2 roles, assigns them to groups, verifies graduated access
- [ ] 7.3 Create a worked example: SMP Admin sets category-scoped default-deny for `ai-skill`, grants `ai-catalog.asset.access` to a Business User role
- [ ] 7.4 Document bundle RBAC filtering behavior (per-viewer skill list may differ)
- [ ] 7.5 Document default-policy setting operational impact (changing after ingestion)
- [ ] 7.6 Conduct usability review with at least one admin persona unfamiliar with the AI Catalog
