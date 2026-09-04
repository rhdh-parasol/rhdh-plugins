# Fullsend AI Pilot

## What is fullsend?

[Fullsend](https://github.com/fullsend-ai/fullsend) is an agentic SDLC platform that provides AI-powered agents for triage, code review, code generation, and retrospectives. It runs as a GitHub Actions pipeline, triggered by GitHub events, and uses Vertex AI (Anthropic Claude) for inference.

## Pilot scope

### Enabled agents

| Agent | Trigger | How to use |
|-------|---------|------------|
| Triage | `/fs-triage` slash command | Post on any issue |
| Coder | `/fs-code` slash command, or `ready-to-code` label | Post on a triaged issue |
| Review | Auto-triggers on PR open/update | Automatic for `workspaces/scorecard/` PRs |
| Fix | `/fs-fix` slash command, or `changes_requested` review | Post on a PR, or request changes on a fullsend PR |
| Package impact | `/fullsend-package-impact` slash command, Monday cron, or **Actions → Fullsend CVE schedule** | Post on an issue or same-repo PR; or run the workflow |

### Auto-trigger vs. manual trigger

Fullsend is designed to chain agents automatically (issue → triage → code → review → fix). In practice, most of that chain requires manual triggering. Here's what actually happens:

| Agent | Designed auto-trigger | What actually happens | How to trigger manually |
|-------|----------------------|----------------------|------------------------|
| Triage | `issues/opened` | **Does not auto-trigger.** The upstream dispatcher only handles `issues/labeled`, not `issues/opened`. | `/fs-triage` on an issue |
| Coder | `ready-to-code` label | **Does not auto-trigger from triage.** Triage labels issues `triaged`, not `ready-to-code`. | `/fs-code` on a triaged issue, or manually add `ready-to-code` label |
| Review | `pull_request_target/opened\|synchronize` | **Auto-triggers on `workspaces/scorecard/` PRs.** This is the only agent that reliably auto-triggers. Scoped via `paths` filter. | `/fs-review` on any PR (auth-gated) |
| Fix | `pull_request_review/submitted` with `changes_requested` | **Partially auto-triggers.** Only fires from bot reviews (e.g., fullsend-review requesting changes), not from human reviews. Effectively scoped to scorecard PRs because only scorecard PRs get auto-reviewed. | `/fs-fix` on a PR, `/fs-fix-stop` to disable |

The "autonomous pipeline" does not chain automatically. In practice: review auto-triggers on augment PRs, everything else is slash-command-driven.

### Scope details

The `paths` filter (`workspaces/scorecard/**`) only applies to the `pull_request_target` event. Other triggers are repo-wide:

- **`issues`** — fires for all issues (fine, since auto-triage doesn't work; slash commands are auth-gated)
- **`issue_comment`** — fires for all comments (auth-gated to OWNER/MEMBER/COLLABORATOR)
- **`pull_request_review`** — fires for all PR reviews (no `paths` support for this event type). Fix is transitively scoped: it only auto-fires from bot reviews, and the review bot only auto-reviews scorecard PRs.

### What does NOT run

| Agent | Why |
|-------|-----|
| Retro | Out of scope for initial pilot |
| Prioritize | Out of scope for initial pilot |

## Slash commands

Slash commands are **restricted to org members and collaborators** via an `author_association` check in the workflow shim. This prevents external users from burning Vertex AI tokens on this public repo.

Available commands:

| Command | What it does |
|---------|-------------|
| `/fs-triage` | Run triage on an issue |
| `/fs-code` | Generate code for a triaged issue |
| `/fs-review` | Run review on a PR |
| `/fs-fix` | Fix issues flagged in a review |
| `/fs-fix-stop` | Disable fix agent for a PR (adds `fullsend-no-fix` label) |
| `/fullsend-risk-rating` | Rate dependency-update risk on a PR (custom agent) |
| `/fullsend-package-impact [workspace] [packages…]` | Classify Dependabot/CVE impact for a workspace and comment a table. Does not bump or dismiss. |

**Scheduled / Actions fan-out** (`.github/workflows/fullsend-cve-schedule.yml`)
follows the CVE schedule plan: a deterministic **plan** job, then one Fullsend
`plugins-package-impact` cell per workspace (**max_parallel** from config),
then a **summary** comment. It does not go through the managed `fullsend.yaml`
shim.

- **Config:** `.fullsend/rhdh/cve-schedule.yaml` — allowlisted `workspaces`,
  `skip`, and `max_parallel`.
- **Schedule:** Mondays 08:00 UTC.
- **Manual:** Actions → **Fullsend CVE schedule** — optional `workspace`,
  `issue_number`, and `dry_run` (plan + summary only).
- **Skips:** no open Dependabot alerts under that workspace; open PR on
  `chore/<workspace>-cve-bumps`; or open PR labeled `fullsend-cve-failed`.
- **v1 cell:** classify + comment (no lockfile bump / PR yet). Slash-command
  `/fullsend-package-impact` still works on any issue/PR and is not gated by
  the schedule allowlist.

**Secret:** set repo Actions secret `DEPENDABOT_TOKEN` (Settings → Secrets
and variables → Actions) to a PAT or GitHub App token with **Dependabot
alerts: read**. The plan job uses it to list alerts (required unless you
pass `workspace=`). The `/fullsend-package-impact` pre-script expects the
same env var on the Fullsend runner (mapped in the harness; never into the
sandbox). Issue/PR APIs still use the minted `REVIEW_TOKEN` / `GH_TOKEN`.

### CVE / Dependabot lockfile bumps

`plugins-package-impact` from
[kim-tsao/rhdh-security-skills](https://github.com/kim-tsao/rhdh-security-skills)
is loaded two ways:

- **Custom agent** (`/fullsend-package-impact`) — classify + patch-status,
  then comment. Pass a workspace (`homepage` or `workspaces/homepage`) and
  optional package names. If omitted, the pre-script uses a single
  `workspace/<name>` label or a PR that only touches one workspace.
  The runner dumps the raw Dependabot list-alerts JSON with
  `DEPENDABOT_TOKEN`; the sandbox runs
  `check-dependabot-patch-status.js --alerts-json` (no Dependabot token in
  the sandbox).
- **Code / fix agents** — same pinned URL skill on `/fs-code` and `/fs-fix`
  so CVE lockfile bumps can follow the skill. Fullsend never dismisses
  alerts.

When the catalog changes, retarget the skill URL in
`.fullsend/rhdh/harness/plugins-package-impact.yaml`, `code.yaml`, and
`fix.yaml` (and the matching `allowed_remote_resources` prefixes).

If `DEPENDABOT_TOKEN` is missing or cannot list alerts, name packages on
the `/fullsend-package-impact` comment. Classification via `yarn why` still
runs without that API. Fullsend never dismisses alerts.

## Coexistence with PR Agent

rhdh-plugins already has [PR Agent](https://github.com/Codium-ai/pr-agent) configured (`.pr_agent.toml`). Both agents run independently:

- **PR Agent** — runs on all PRs across the entire repo
- **Fullsend Review** — auto-triggers only on PRs touching `workspaces/scorecard/`

This parallel setup allows comparing review quality. Neither blocks the other. PR Agent configuration is not modified.

## How to expand review to more workspaces

Add paths to the `paths` filter in `.github/workflows/fullsend.yaml`:

```yaml
on:
  pull_request_target:
    types: [opened, synchronize, ready_for_review, closed]
    paths:
      - "workspaces/scorecard/**"
      - "workspaces/your-new-workspace/**"  # add here
```

To enable review for ALL workspaces, remove the `paths` filter entirely.

Note: the `paths` filter only affects the Review agent's auto-trigger. Triage, coder, and fix are already available repo-wide via slash commands.

## Authorization model

### Slash command auth gate

The dispatch job checks `author_association` on `issue_comment` events. Only `OWNER`, `MEMBER`, and `COLLABORATOR` can trigger agents via slash commands. External contributors are silently ignored.

### CODEOWNERS protection

The `.fullsend/` directory and `.github/workflows/fullsend.yaml` are protected via CODEOWNERS, requiring `@redhat-developer/rhdh-plugins-maintainers` approval. This prevents agents from modifying their own configuration.

### GitHub branch protection

`require_code_owner_reviews: true` on the default branch ensures CODEOWNERS rules are enforced. This is the actual merge safety layer — independent of fullsend.

### Inference authentication

Fullsend uses GCP Workload Identity Federation (WIF) to authenticate GitHub Actions runs against Vertex AI. The WIF provider is scoped to this specific repo. Credentials are stored as GitHub secrets, not in committed files.

## Configuration files

| Path | Purpose |
|------|---------|
| `.fullsend/config.yaml` | Declares enabled roles (triage, coder, review, fix) |
| `.fullsend/customized/` | Scaffold for future agent customization (agents, harness, policies, schemas, env, scripts, skills) |
| `.github/workflows/fullsend.yaml` | Event shim — routes GitHub events to fullsend's reusable workflows, with auth gate on slash commands |
| `.github/workflows/fullsend-cve-schedule.yml` | Monday cron + `workflow_dispatch` plan/matrix/summary for package-impact |
| `.fullsend/rhdh/cve-schedule.yaml` | Allowlist, skip list, and `max_parallel` for the CVE schedule |

## Debugging

### Layer 1: Workflow logs

```bash
gh run list --workflow=fullsend.yaml --repo redhat-developer/rhdh-plugins
gh run view <run-id> --repo redhat-developer/rhdh-plugins --log
```

### Layer 2: Agent transcripts

```bash
gh run download <run-id> --repo redhat-developer/rhdh-plugins -n transcript
```

### Layer 3: Sandbox logs

Available in the workflow run logs under the sandbox creation step. Look for `fullsend run` output.

### Common issues

| Symptom | Likely cause |
|---------|-------------|
| Slash command ignored | Commenter is not OWNER/MEMBER/COLLABORATOR |
| Review doesn't trigger | PR doesn't touch files in `workspaces/scorecard/` |
| 403 from mint | Repo not in mint's `ALLOWED_ORGS` — contact fullsend team |
| `aiplatform.endpoints.predict` denied | WIF IAM binding missing on GCP project |
| Agent produces no output | Check transcript artifact for agent errors |

## Reference

For a comprehensive deep-dive into fullsend agents, customization, and debugging, see the [fullsend-agents.md](https://github.com/redhat-developer/rhdh-agentic/blob/main/docs/fullsend-agents.md) in rhdh-agentic.
