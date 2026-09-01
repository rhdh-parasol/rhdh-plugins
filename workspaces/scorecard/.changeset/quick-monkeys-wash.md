---
'@rhdh-parasol/backstage-plugin-scorecard-backend-module-dora': minor
'@rhdh-parasol/backstage-plugin-scorecard-backend-module-github': minor
'@rhdh-parasol/backstage-plugin-scorecard-backend-module-jira': minor
'@rhdh-parasol/backstage-plugin-scorecard-backend': minor
'@rhdh-parasol/backstage-plugin-scorecard-common': minor
'@rhdh-parasol/backstage-plugin-scorecard': minor
---

Add DORA metrics and a collectors framework for composing datasource data into metrics.

- New `@rhdh-parasol/backstage-plugin-scorecard-backend-module-dora` with Deployment Frequency, Median Lead Time for Changes, Mean Time to Restore, and Change Failure Rate
- New data collectors used by DORA: GitHub deployments, deployment workflow runs, and deployment pull requests; Jira incidents
- Metric time-series API `/metrics/catalog/:kind/:namespace/:name/time-series`
- Adds `defaultVisualization` to Metric metadata for sparkline
