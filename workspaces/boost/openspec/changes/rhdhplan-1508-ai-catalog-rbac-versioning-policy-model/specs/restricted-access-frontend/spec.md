# Restricted-Access Frontend

> Frontend components for graduated visibility placeholders.
> Sub-issue: RHDHPLAN-1653

The frontend MUST render a restricted-access placeholder when the authenticated
user lacks `ai-catalog.asset.access.usage-docs` for a given asset, so that
tier-1 users understand that additional content exists but is not available to
them.

## ADDED Requirements

### Requirement: Restricted-access placeholder rendering

When a tier-1 user views an AI asset entity page, the sections that would
display usage instructions, configuration snippets, and connection endpoints
MUST render a restricted-access placeholder instead of the actual content.

#### Scenario: Tier-1 user views asset detail page

- **WHEN** a user with `ai-catalog.asset.access` but not
  `ai-catalog.asset.access.usage-docs` views an AI asset entity page
- **THEN** the usage/install instructions section renders a restricted-access
  placeholder
- **AND** the configuration snippets section renders a restricted-access
  placeholder
- **AND** the connection endpoints section renders a restricted-access
  placeholder

#### Scenario: Placeholder includes access guidance

- **WHEN** the restricted-access placeholder is rendered
- **THEN** it displays a message directing the user to request access or
  contact the asset owner

### Requirement: Full content for tier-2 users

When a tier-2 user views the same asset entity page, all sections render
normally with no placeholder.

#### Scenario: Tier-2 user sees full content

- **WHEN** a user with both `ai-catalog.asset.access` and
  `ai-catalog.asset.access.usage-docs` views an AI asset entity page
- **THEN** usage instructions, configuration snippets, and connection endpoints
  render with their actual content
- **AND** no restricted-access placeholder is shown

### Requirement: Consistent placeholder component

A single reusable UI component MUST be used for all restricted-access
placeholders across AI Catalog surfaces, following the same pattern as the
Augment Plugin's security gate UI.

#### Scenario: Placeholder component reuse

- **WHEN** multiple AI Catalog views need to gate content behind
  `ai-catalog.asset.access.usage-docs`
- **THEN** each view uses the shared restricted-access placeholder component
- **AND** the visual style and messaging are consistent
