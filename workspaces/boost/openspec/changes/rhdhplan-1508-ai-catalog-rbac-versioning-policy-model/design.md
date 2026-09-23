# Design: AI Catalog RBAC & Versioning Policy Model

## Canonical Touchpoints

- `openspec/specs/` — No existing long-lived specs are modified. The six new
  capability specs live in this change and may be promoted to long-lived specs
  after implementation.
- `specifications/prd/` — None affected.
- `specifications/adr/` — None affected.
- `openspec/changes/ai-catalog-asset-governance/` — The existing governance
  change takes a conservative, decision-gated approach (use `catalog.entity.read`
  first, add project-specific permissions only when proven necessary). This
  change records the full RHDHPLAN-1508 requirements using the project-specific
  permissions already defined in the codebase. Implementation should reconcile
  the two approaches.

No canonical document updates.

## Context

The AI Catalog frontend and OGX entity provider ship in RHDH 2.1 with no
AI-Catalog-specific RBAC enforcement. Entity visibility relies on Backstage's
built-in `catalog.entity.read`. Three AI Catalog permissions are already
defined in `ai-catalog-common/src/permissions.ts`:

- `ai-catalog.asset.access` (resource type: `ai-catalog-asset`)
- `ai-catalog.asset.access.usage-docs` (resource type: `ai-catalog-asset`)
- `ai-catalog.admin` (non-resource permission)

Three conditional rule names are also defined:

- `isAiAssetCategory` — matches by `rhdh.io/ai-asset-category`
- `isFromConnector` — matches by `rhdh.io/ai-asset-source`
- `isInTenant` — matches by namespace or `rhdh.io/ai-asset-tenant`

The definitions exist but enforcement logic, frontend gating, cascade
semantics, admin UI, and audit integration are all pending.

RHDHPLAN-1508 depends on RHDHPLAN-1507 (AI Asset Entity Model & Ingestion
Framework) for the `rhdh.io/ai-asset-version` annotation and shared asset
identifier.

## Goals / Non-Goals

**Goals:**

- Implement graduated visibility: two-tier access (discovery vs. full usage
  docs) enforced at the backend API boundary.
- Implement asset-to-version policy cascade with version-specific overrides.
- Implement conditional policies scoped by category, connector, and tenant.
- Provide admin-configurable default-allow/deny posture (ships as deny).
- Add a dedicated RBAC admin UI section for the SMP Admin persona.
- Implement read-time SkillBundle filtering based on viewer permissions.
- Emit audit events for RBAC policy changes and ingestion sync events.

**Non-Goals:**

- Defining the entity model or ingestion framework (RHDHPLAN-1507).
- Connector-specific RBAC mapping or pass-through of source registry
  permissions.
- Building a new permission engine, policy DSL, or policy storage layer.
- Per-tenant data isolation at the ingestion or storage layer.
- Fine-grained field-level permissions beyond the two-tier model.
- Operating or managing the Neo4j knowledge graph directly.

## Decisions

### D1: Use project-specific AI Catalog permissions (not catalog.entity.read alone)

The codebase already defines `ai-catalog.asset.access` and
`ai-catalog.asset.access.usage-docs` as resource permissions on the
`ai-catalog-asset` resource type. RHDHPLAN-1508 requires graduated visibility
(discoverable vs. full usage docs), which `catalog.entity.read` alone cannot
express — it is binary (visible or not).

**Alternative considered:** The `ai-catalog-asset-governance` change proposed
using only `catalog.entity.read` and deferring project-specific permissions.
This was rejected because the two-tier visibility model is a core feature
requirement, not an optional enhancement.

### D2: Field-level filtering at the backend API boundary

Protected fields (usage docs, configuration, connection endpoints) are stripped
from API responses when the caller lacks `ai-catalog.asset.access.usage-docs`.
The frontend receives only the data it may display. This is a security boundary;
frontend rendering is not.

**Alternative considered:** Frontend-only gating using `RequirePermission`. This
was rejected because the client would still receive the protected data.

### D3: Version cascade via shared asset identifier

Policy cascade from asset to versions uses the shared asset identifier from
RHDHPLAN-1507. A version-specific override (matched by asset identifier plus
`rhdh.io/ai-asset-version`) takes precedence. This avoids a custom policy
inheritance engine — the evaluation logic checks for a version-specific policy
first, then falls back to the asset-level policy.

### D4: Reuse AuditorService for audit events

Both RBAC policy change events and ingestion sync events emit through RHDH's
existing `AuditorService`. No second audit channel or custom audit view is
introduced.

### D5: SkillBundle filtering at the API layer

Bundle skill lists are filtered at read time by the backend API that serves
bundle detail views. Neo4j stores the complete bundle; filtering is applied
per-request based on the viewer's permissions.

### D6: Admin UI extends existing RBAC admin surface

The AI Catalog policy management section is added to the existing RBAC admin
UI. No standalone AI Catalog policy page is created. The section is gated by
`ai-catalog.admin`.

## Risks / Trade-offs

- **[Two permission checks per asset request]** — Each AI Catalog query
  evaluates both `ai-catalog.asset.access` and potentially
  `ai-catalog.asset.access.usage-docs`. Mitigation: p95 latency budget of
  <10% regression; batch evaluation where the Permission Framework supports it.
- **[Cascade complexity]** — Asset-to-version cascade adds evaluation logic
  beyond standard Catalog permission checks. Mitigation: version-specific
  override takes simple precedence; cascade is a fallback lookup, not a
  recursive traversal.
- **[Default-deny operational impact]** — Shipping with `deny` as default means
  newly-ingested assets are invisible until an admin creates a policy. This is
  the correct posture for regulated environments but may surprise evaluation
  users. Mitigation: documentation and in-product help text; `allow` option
  available.
- **[Reconciliation with existing governance change]** — The
  `ai-catalog-asset-governance` change takes a more conservative approach.
  Mitigation: implementation planning should reconcile the two; the existing
  governance specs serve as the conservative fallback if specific RHDHPLAN-1508
  requirements prove impractical.

## Open Questions

- How does the version cascade interact with the entity-provider refresh cycle?
  (Depends on RHDHPLAN-1507 entity lifecycle details.)
- Should the per-category default-policy setting be a configuration key or an
  RBAC conditional policy? (Implementation choice — both can express the
  requirement.)
