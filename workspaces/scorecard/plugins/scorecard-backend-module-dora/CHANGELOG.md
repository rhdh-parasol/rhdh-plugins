# @rhdh-parasol/backstage-plugin-scorecard-backend-module-dora

## 1.0.1

### Patch Changes

- @rhdh-parasol/backstage-plugin-scorecard-common@5.0.1
- @rhdh-parasol/backstage-plugin-scorecard-node@5.0.1

## 1.0.0

### Major Changes

- 71e0f9e: Publish scorecard packages under the `@rhdh-parasol` npm scope from this fork.

### Minor Changes

- ff6683f: Add DORA metrics and a collectors framework for composing datasource data into metrics.

  - New `@rhdh-parasol/backstage-plugin-scorecard-backend-module-dora` with Deployment Frequency, Median Lead Time for Changes, Mean Time to Restore, and Change Failure Rate
  - New data collectors used by DORA: GitHub deployments, deployment workflow runs, and deployment pull requests; Jira incidents
  - Metric time-series API `/metrics/catalog/:kind/:namespace/:name/time-series`
  - Adds `defaultVisualization` to Metric metadata for sparkline

- f3f71a5: Add unit to metric and display it in threshold legend

### Patch Changes

- Updated dependencies [71e0f9e]
- Updated dependencies [ff6683f]
- Updated dependencies [f3f71a5]
  - @rhdh-parasol/backstage-plugin-scorecard-common@5.0.0
  - @rhdh-parasol/backstage-plugin-scorecard-node@5.0.0
