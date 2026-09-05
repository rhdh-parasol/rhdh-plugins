/*
 * Copyright Red Hat, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 */
import type {
  Delivery,
  DeliveryBuild,
  DeliveryCandidate,
  LifecycleProjection,
} from '@red-hat-developer-hub/backstage-plugin-lifecycle-common';
import type { StoredChange } from '../database/types';
import { mainlineRuns } from './deliveryCandidates';

function deliveryBuild(
  run: LifecycleProjection['ciRuns'][number],
): DeliveryBuild {
  return {
    runId: run.runId,
    runNumber: run.runNumber,
    runAttempt: run.runAttempt ?? run.attempt,
    status: run.status,
    conclusion: run.conclusion,
    repository: run.repository,
    branch: run.branch,
    commitSha: run.commitSha,
    commitUrl:
      run.repository && run.commitSha
        ? `https://github.com/${run.repository}/commit/${run.commitSha}`
        : undefined,
    jobName: run.jobName,
    url: run.url,
    updatedAt: run.updatedAt ?? run.completedAt ?? run.startedAt,
  };
}

export interface DeliveryStatusInput {
  candidates: DeliveryCandidate[];
  changes: StoredChange[];
  releasedPackages: Delivery['releasedPackages'];
}

/** Derives the high-level delivery status from candidates and mainline health. */
export function deliveryStatus({
  candidates,
  changes,
  releasedPackages,
}: DeliveryStatusInput): Pick<
  Delivery,
  | 'status'
  | 'statusReason'
  | 'mainline'
  | 'nextAction'
  | 'nextActionUrl'
  | 'nextActionLabel'
> {
  const runs = mainlineRuns(changes);
  const latestBuild = runs[0];
  const latestSuccessfulBuild = runs.find(
    run => run.status === 'completed' && run.conclusion === 'success',
  );
  let status: Delivery['status'] = 'unknown';
  let statusReason = 'No live delivery evidence has been synchronized yet.';
  let nextAction: string | undefined;
  let nextActionUrl: string | undefined;
  let nextActionLabel: string | undefined;
  const failedCandidate = candidates.find(
    candidate =>
      candidate.publishStatus === 'failure' ||
      candidate.smokeTestStatus === 'failure',
  );
  const runningCandidate = candidates.find(candidate =>
    ['pending', 'running'].includes(candidate.publishStatus),
  );
  const runningVerification = candidates.find(candidate =>
    ['pending', 'running'].includes(candidate.smokeTestStatus),
  );
  const testableCandidate = candidates.find(
    candidate =>
      candidate.publishStatus === 'success' &&
      candidate.smokeTestStatus === 'not_run' &&
      candidate.candidateImages.length > 0,
  );
  const mergeableCandidate = candidates.find(
    candidate =>
      candidate.publishStatus === 'success' &&
      candidate.smokeTestStatus === 'success' &&
      candidate.candidateImages.length > 0,
  );
  const missingCandidateEvidence = candidates.find(
    candidate =>
      candidate.publishStatus === 'unknown' ||
      (candidate.publishStatus === 'success' &&
        candidate.candidateImages.length === 0),
  );
  if (failedCandidate) {
    status = 'attention_required';
    statusReason = failedCandidate.blocker ?? 'A candidate check failed.';
    nextAction = failedCandidate.nextAction;
    nextActionUrl = failedCandidate.nextActionUrl;
    nextActionLabel = failedCandidate.nextActionLabel;
  } else if (runningCandidate) {
    status = 'in_progress';
    statusReason = 'A candidate build is still running.';
    nextAction = 'Wait for the candidate checks to finish.';
    nextActionUrl = runningCandidate.publishUrl;
    nextActionLabel = 'Open running publish check';
  } else if (runningVerification) {
    status = 'in_progress';
    statusReason = 'A candidate smoke test is still running.';
    nextAction = 'Wait for the candidate smoke test to finish.';
    nextActionUrl = runningVerification.smokeTestUrl;
    nextActionLabel = 'Open running smoke test';
  } else if (testableCandidate) {
    status = 'ready_to_test';
    statusReason = 'Candidate images are available and need verification.';
    nextAction = testableCandidate.nextAction;
    nextActionUrl = testableCandidate.nextActionUrl;
    nextActionLabel = testableCandidate.nextActionLabel;
  } else if (mergeableCandidate) {
    status = 'ready_to_merge';
    statusReason = 'Candidate verification succeeded.';
    nextAction = mergeableCandidate.nextAction;
    nextActionUrl = mergeableCandidate.nextActionUrl;
    nextActionLabel = mergeableCandidate.nextActionLabel;
  } else if (missingCandidateEvidence) {
    status = 'unknown';
    statusReason =
      missingCandidateEvidence.blocker ??
      'Candidate publication evidence is incomplete.';
    nextAction =
      'Refresh or rerun the PR publish workflow to restore its artifact.';
    nextActionUrl = missingCandidateEvidence.pullRequestUrl;
    nextActionLabel = 'Open pull request';
  } else if (
    latestBuild &&
    (latestBuild.status !== 'completed' || latestBuild.conclusion === 'failure')
  ) {
    status =
      latestBuild.status === 'completed' ? 'attention_required' : 'in_progress';
    statusReason =
      latestBuild.status === 'completed'
        ? 'The latest mainline workspace build failed.'
        : 'The latest mainline workspace build is still running.';
    nextAction = latestBuild.url
      ? 'Inspect the latest mainline build.'
      : undefined;
    nextActionUrl = latestBuild.url;
    nextActionLabel =
      latestBuild.status === 'completed'
        ? 'Inspect failed workspace job'
        : 'Open running workspace job';
  } else if (
    latestBuild?.status === 'completed' &&
    latestBuild.conclusion === 'success'
  ) {
    status = 'stable';
    statusReason =
      'The latest mainline workspace build succeeded and no active delivery issue was observed.';
  } else if (releasedPackages.length > 0) {
    status = 'unknown';
    statusReason =
      'A Catalog-listed release is available, but no current candidate or mainline build evidence was found.';
  }
  return {
    status,
    statusReason,
    mainline: {
      latestBuild: latestBuild ? deliveryBuild(latestBuild) : undefined,
      latestSuccessfulBuild: latestSuccessfulBuild
        ? deliveryBuild(latestSuccessfulBuild)
        : undefined,
    },
    nextAction,
    nextActionUrl,
    nextActionLabel,
  };
}
