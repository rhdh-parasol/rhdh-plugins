# Scoring rubric

The score is computed by `scripts/score.ts` — never by hand. This document
explains the model so you can interpret results and explain them to the user.

## Model

Each package gets an additive score, clamped to 0–10 internally and displayed
×10 as 0–100. Score bands (configurable via `bands:` in `.dependency-risk.yaml`):

| Internal score | Band |
|---|---|
| 0–2 | LOW |
| 3–5 | MEDIUM |
| ≥ 6 | HIGH |

The **overall rating** is the highest package band, escalated one band when
more than `manyPackagesThreshold` (default 100) packages changed AND fewer than
80% could be fully analyzed.

## Default weights

Every key can be overridden in the target repo's `.dependency-risk.yaml` under
`weights:`. Source of truth: `DEFAULT_WEIGHTS` in `scripts/score.ts`.

| Signal | Weight key | Points |
|---|---|---|
| Minor version bump (or patch bump on 0.x) | `deltaMinor` | +1 |
| Major version bump (or minor bump on 0.x) | `deltaMajor` | +3 |
| Major bump whose only breaking change is dropping EOL Node.js | `majorNodeDropOnly` | +1 (replaces `deltaMajor`) |
| Version downgrade | `downgrade` | +3 |
| Prerelease target version (beta/rc/next) | `prereleaseTarget` | +2 |
| Published < `minAgeDays` (default 3) ago | `ageBelowMin` | +3 |
| Published 3–14 days ago | `ageUnder14Days` | +1 |
| < 1k weekly downloads | `downloadsUnder1k` | +2 |
| 1k–100k weekly downloads | `downloadsUnder100k` | +1 |
| Known vulnerability **introduced** by the update | `osvIntroduced` | +5 and band forced to HIGH |
| Known vulnerability **fixed** by the update | `osvFixed` | −2 |
| Target version is deprecated | `deprecated` | +3 |
| Update **adds** an install script (pre/post/install) | `installScriptAdded` | +4 |
| Different npm publisher than the previous version | `publisherChanged` | +2 |
| License changed | `licenseChanged` | +2 |
| npm provenance attestation present | `provenance` | −1 |
| Matches the pinned Backstage release manifest | `backstageMatch` | −2 |
| Does NOT match the Backstage release manifest | `backstageMismatch` | +3 |
| Changelog judged bugfixes-only | `changelogBugfixOnly` | −1 |
| Changelog judged significant | `changelogSignificant` | +2 |
| OpenSSF Scorecard < 4 | `scorecardLow` | 0 (informational; set > 0 to enable) |
| Support level (from the skill's `scripts/data/support-levels.yaml`) | — | production 0 / tech-preview +1 / dev-preview +2 / unknown +1 (ecosystem packages only) |

Notes on 0.x versions: for `0.x` packages a minor bump is treated as major and
a patch bump as minor (`effectiveType` in the delta), because semver makes no
compatibility promise below 1.0 and the Backstage ecosystem bumps minor for
breaking changes.

## Trusted packages

Packages matching `trustedPackages` (default `@red-hat-developer-hub/*`) are
capped at LOW ("a change is always okay"). Exception: when
`trustedOverridesSecurity: true` (default), a security signal still surfaces —
an introduced vulnerability forces HIGH, and a newly added install script
keeps its real score. A compromised trusted scope must never be hidden by the
allowlist.

## Confidence vs. score

- **Assessment confidence** (high/medium/low) reflects data completeness:
  API failures and light-analysis packages lower it. It never changes the score.
- **Test confidence** (from codecov coverage or `testConfidence` config)
  shapes only the recommendation text: high coverage → "a green CI run is a
  strong signal"; low coverage → "verify manually".

## Worked example

`tiny-evil-lib 1.4.2 → 2.0.0`, published 5 hours ago, 412 weekly downloads,
adds a postinstall script, new publisher, changelog judged significant:

    major (+3) + age<3d (+3) + downloads<1k (+2) + install script (+4)
    + publisher change (+2) + changelog significant (+2) = 16 → clamped 10
    → HIGH (100/100)

`lodash 4.17.20 → 4.17.21`, 4+ years old, 45M downloads/week, fixes a CVE,
changelog bugfixes-only:

    patch (0) + fixes CVE (−2) + bugfix-only (−1) = −3 → clamped 0 → LOW (0/100)
