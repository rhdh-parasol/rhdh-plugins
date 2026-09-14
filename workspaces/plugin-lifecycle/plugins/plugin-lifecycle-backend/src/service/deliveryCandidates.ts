/*
 * Copyright Red Hat, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 */
import type {
  DeliveryCandidate,
  LifecycleProjection,
  LifecycleState,
} from '@red-hat-developer-hub/backstage-plugin-lifecycle-common';
import type { StoredChange } from '../database/types';

function runTime(run: {
  updatedAt?: string;
  completedAt?: string;
  startedAt?: string;
}): number {
  for (const value of [run.updatedAt, run.completedAt, run.startedAt]) {
    if (!value) continue;
    const timestamp = Date.parse(value);
    if (Number.isFinite(timestamp)) return timestamp;
  }
  return 0;
}

function runStatus(
  run: LifecycleProjection['ciRuns'][number] | undefined,
): 'unknown' | 'pending' | 'running' | 'success' | 'failure' {
  if (!run) return 'unknown';
  if (run.status === 'queued') return 'pending';
  if (run.status === 'in_progress') return 'running';
  return run.conclusion === 'success' ? 'success' : 'failure';
}

function phaseRunStatus(
  state: LifecycleState | undefined,
): 'unknown' | 'pending' | 'running' | 'success' | 'failure' {
  switch (state) {
    case 'succeeded':
      return 'success';
    case 'failed':
    case 'blocked':
      return 'failure';
    case 'running':
      return 'running';
    case 'pending':
      return 'pending';
    default:
      return 'unknown';
  }
}

function verificationStatus(
  state: LifecycleState,
): DeliveryCandidate['smokeTestStatus'] {
  switch (state) {
    case 'succeeded':
      return 'success';
    case 'failed':
    case 'blocked':
      return 'failure';
    case 'running':
      return 'running';
    default:
      return 'pending';
  }
}

/** Maps persisted PR changes into the compact candidate read model. */
export function deliveryCandidates(
  changes: StoredChange[],
): DeliveryCandidate[] {
  return changes
    .filter(
      change =>
        change.summary.scope === 'pull_request' &&
        change.summary.externalStatus === 'open' &&
        change.summary.origin !== 'fixture',
    )
    .map(change => {
      const runs = change.projection.ciRuns
        .filter(run => !run.fixture)
        .sort((left, right) => runTime(right) - runTime(left));
      const publishCheck = runs.find(
        run =>
          run.provider === 'github-commit-status' && run.jobName === 'publish',
      );
      const smokeCheck = runs.find(
        run =>
          run.provider === 'github-commit-status' &&
          run.jobName === 'smoketest',
      );
      const latestRun = runs.find(
        run => run.provider !== 'github-commit-status',
      );
      const verification = change.projection.phaseStates?.find(
        state => state.phase === 'verification',
      );
      const buildPhase = change.projection.phaseStates?.find(
        state => state.phase === 'build',
      );
      const pullRequest = change.projection.references.find(
        reference => reference.type === 'pull_request',
      );
      const sourceReference = change.projection.references.find(
        reference => reference.type === 'source',
      );
      const publishStatus = publishCheck
        ? runStatus(publishCheck)
        : phaseRunStatus(buildPhase?.state);
      const smokeCheckStatus = smokeCheck ? runStatus(smokeCheck) : undefined;
      let smokeTestStatus: DeliveryCandidate['smokeTestStatus'] = 'not_run';
      if (smokeCheckStatus && smokeCheckStatus !== 'unknown') {
        smokeTestStatus = smokeCheckStatus;
      } else if (verification) {
        smokeTestStatus = verificationStatus(verification.state);
      }
      const candidateImages = change.projection.artifacts
        .filter(artifact => artifact.artifactType === 'oci')
        .map(artifact => ({
          reference: artifact.reference,
          packageEntityRef: artifact.packageEntityRef,
          version: artifact.version,
          observedAt: change.summary.lastOccurredAt ?? change.summary.updatedAt,
        }));
      let blocker = change.projection.blocker;
      if (!blocker && publishStatus === 'failure')
        blocker = 'The candidate publish check failed.';
      if (!blocker && smokeTestStatus === 'failure')
        blocker = 'The candidate smoke test failed.';
      if (
        !blocker &&
        publishStatus === 'success' &&
        candidateImages.length === 0
      ) {
        blocker =
          'The publish check succeeded, but the candidate image artifact is unavailable or expired.';
      }
      if (!blocker && publishStatus === 'unknown') {
        blocker =
          'No publish check result is available for this open pull request.';
      }

      let nextAction: string | undefined;
      let nextActionUrl: string | undefined;
      let nextActionLabel: string | undefined;
      if (publishStatus === 'failure' || smokeTestStatus === 'failure') {
        nextAction = 'Inspect the failing check and update the pull request.';
        nextActionUrl =
          publishStatus === 'failure'
            ? publishCheck?.url ?? buildPhase?.evidenceUrl
            : smokeCheck?.url ?? verification?.evidenceUrl;
        nextActionLabel =
          publishStatus === 'failure'
            ? 'Inspect failed publish check'
            : 'Inspect failed smoke test';
      } else if (publishStatus === 'unknown') {
        nextAction = 'Run or refresh the pull request publish workflow.';
        nextActionUrl = pullRequest?.url;
        nextActionLabel = 'Open pull request';
      } else if (publishStatus === 'success' && smokeTestStatus === 'not_run') {
        nextAction = 'Install and test the candidate OCI images.';
        nextActionUrl = publishCheck?.url ?? buildPhase?.evidenceUrl;
        nextActionLabel = 'Open candidate publish evidence';
      } else if (smokeTestStatus === 'success') {
        nextAction = 'Review the pull request for merge.';
        nextActionUrl = pullRequest?.url;
        nextActionLabel = 'Review pull request';
      }

      return {
        changeId: change.summary.changeId,
        title: change.summary.title,
        author: pullRequest?.author,
        pullRequestNumber:
          latestRun?.pullRequestNumber ??
          (pullRequest?.externalId
            ? Number.parseInt(pullRequest.externalId, 10)
            : undefined),
        pullRequestUrl: pullRequest?.url,
        sourceRevision:
          publishCheck?.sourceCommitSha ??
          publishCheck?.commitSha ??
          latestRun?.sourceCommitSha ??
          latestRun?.commitSha ??
          sourceReference?.externalId,
        sourceUrl: sourceReference?.url,
        updatedAt:
          pullRequest?.updatedAt ??
          change.summary.lastOccurredAt ??
          change.summary.updatedAt,
        publishStatus,
        publishUrl:
          publishCheck?.url ?? latestRun?.url ?? buildPhase?.evidenceUrl,
        smokeTestStatus,
        smokeTestUrl: smokeCheck?.url ?? verification?.evidenceUrl,
        candidateImages,
        blocker,
        nextAction,
        nextActionUrl,
        nextActionLabel,
      };
    });
}

export function mainlineRuns(changes: StoredChange[]) {
  return changes
    .filter(
      change =>
        change.summary.scope === 'branch' &&
        change.summary.origin !== 'fixture',
    )
    .flatMap(change => change.projection.ciRuns)
    .filter(
      run =>
        !run.fixture &&
        Boolean(
          run.branch &&
            (run.branch === 'main' ||
              run.branch === 'master' ||
              run.branch.startsWith('release-') ||
              run.branch.startsWith('release/')),
        ),
    )
    .sort((left, right) => runTime(right) - runTime(left));
}
