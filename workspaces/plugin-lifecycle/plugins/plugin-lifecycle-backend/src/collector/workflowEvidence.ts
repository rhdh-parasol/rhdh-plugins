/*
 * Copyright Red Hat, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 */
import type { Entity } from '@backstage/catalog-model';
import type { CiRun } from '@red-hat-developer-hub/backstage-plugin-lifecycle-common';
import type { LifecycleService } from '../service/LifecycleService';
import {
  annotationRefs,
  artifactDigest,
  cachedValue,
  catalogEntityRef,
  conclusion,
  escapeRegExp,
  eventId,
  mapWithConcurrency,
  pullRequestExternalStatus,
  recordArtifactEvent,
  runReference,
  slug,
  workspace,
  type CollectionCache,
  type MatchingJob,
} from './collectorHelpers';
import type { LifecycleSyncState } from '../database/types';
import type {
  GitHubActionsReader,
  GitHubWorkflowJob,
  GitHubWorkflowRun,
} from './githubReader';
import { collectPullRequestEvidence } from './pullRequestEvidence';

const SOURCE_SHA = 'rhdh.io/source-revision';
const LEGACY_SOURCE_SHA = 'rhdh.io/source-commit-sha';
const SOURCE_REPOSITORY = 'rhdh.io/source-repository';
const PACKAGE_REFS = 'rhdh.io/extensions-package-refs';
const GITHUB_REQUEST_CONCURRENCY = 8;
export const MAX_BOOTSTRAP_RUNS_PER_WORKFLOW = 50;

export async function collectWorkflowEvidence(input: {
  overlay: Entity;
  cache: CollectionCache;
  bootstrap?: boolean;
  reader: GitHubActionsReader;
  service: LifecycleService;
  workflowFile: string;
  requireManifest: boolean;
  closedPullRequestsPerWorkspace: number;
  updateSyncState: (
    entityRef: string,
    state: LifecycleSyncState,
  ) => Promise<void>;
}): Promise<{ changes: number; events: number }> {
  const {
    overlay,
    cache,
    bootstrap = false,
    reader,
    service,
    workflowFile,
    requireManifest,
    closedPullRequestsPerWorkspace,
    updateSyncState,
  } = input;

  const overlayRef = catalogEntityRef(overlay);
  await updateSyncState(overlayRef, {
    status: 'running',
    lastAttemptAt: new Date().toISOString(),
  });
  const repository = slug(overlay)!;
  // PR evidence is the most useful result of an on-demand refresh and is
  // independent of the mainline workflow scan. Collect it first so open and
  // closed changes are persisted even when the larger job scan exceeds the
  // HTTP wait budget.
  const pullRequestResult = await collectPullRequestEvidence({
    overlay,
    cache,
    reader,
    service,
    closedPullRequestsPerWorkspace,
  });
  const runsKey = `${repository}:${workflowFile}`;
  const runs = await cachedValue(cache, `runs:${runsKey}`, cache.runs, () =>
    reader.listRuns(repository, workflowFile, bootstrap ? 50 : 100),
  );
  const targetSha =
    overlay.metadata.annotations?.[SOURCE_SHA] ??
    overlay.metadata.annotations?.[LEGACY_SOURCE_SHA] ??
    runs[0]?.head_sha ??
    'unknown';
  const workspaceName = workspace(overlay);
  const runJobs = await mapWithConcurrency(
    runs,
    GITHUB_REQUEST_CONCURRENCY,
    async run => {
      const runAttempt = run.run_attempt ?? 1;
      const jobsKey = `${repository}:${run.id}:${runAttempt}`;
      const jobs = await cachedValue(cache, `jobs:${jobsKey}`, cache.jobs, () =>
        reader.listJobs(repository, run.id, runAttempt),
      );
      return { run, jobs };
    },
  );
  const matchingJobs: MatchingJob[] = [];
  for (const { run, jobs } of runJobs) {
    for (const job of jobs) {
      if (
        new RegExp(
          `(?:^|[ /])workspaces/${escapeRegExp(workspaceName)}(?:$|[ /])`,
        ).test(job.name)
      ) {
        matchingJobs.push({ run, job });
      }
    }
  }
  if (matchingJobs.length === 0) {
    await service.recordSystemDiagnostic({
      source: 'github-actions',
      subjectEntityRef: catalogEntityRef(overlay),
      externalId: `${repository}:${workspaceName}`,
      reasonCode: 'workspace-job-not-found',
      summary: `No GitHub Actions job matched workspace ${workspaceName}`,
      details: {
        repository,
        workspace: workspaceName,
        workflowRuns: runs.length,
      },
    });
    await updateSyncState(overlayRef, {
      status: 'empty',
      lastAttemptAt: new Date().toISOString(),
      lastSuccessAt: new Date().toISOString(),
    });
    await updateSyncState(overlayRef, {
      status: pullRequestResult.changes > 0 ? 'succeeded' : 'empty',
      lastAttemptAt: new Date().toISOString(),
      lastSuccessAt: new Date().toISOString(),
    });
    return pullRequestResult;
  }
  const groups = new Map<
    string,
    Array<{ run: GitHubWorkflowRun; job: GitHubWorkflowJob }>
  >();
  for (const matching of matchingJobs) {
    const pullRequestNumber = matching.run.pull_requests?.[0]?.number;
    const key = pullRequestNumber
      ? `github:${repository}:pr:${pullRequestNumber}:workspace:${workspaceName}`
      : `github:${repository}:ref:${
          matching.run.head_branch ?? 'unknown'
        }:commit:${
          matching.run.head_sha ?? targetSha
        }:workspace:${workspaceName}`;
    const group = groups.get(key) ?? [];
    group.push(matching);
    groups.set(key, group);
  }

  let totalEvents = 0;
  const associations = await service.associationsForEntity(overlay);
  for (const [externalChangeKey, group] of groups) {
    const firstRun = group[0].run;
    const pullRequestNumber = firstRun.pull_requests?.[0]?.number;
    const pullRequest = pullRequestNumber
      ? cache.pullRequests
          .get(`${repository}:open`)
          ?.find(candidate => candidate.number === pullRequestNumber) ??
        cache.pullRequests
          .get(`${repository}:closed`)
          ?.find(candidate => candidate.number === pullRequestNumber)
      : undefined;
    const externalStatus = pullRequest
      ? pullRequestExternalStatus(pullRequest)
      : 'open';
    const change = await service.createSystemChange(
      {
        requestId: externalChangeKey,
        subjectEntityRef: `${overlay.kind.toLocaleLowerCase('en-US')}:${
          overlay.metadata.namespace ?? 'default'
        }/${overlay.metadata.name}`,
        // Keep the idempotent request payload identical to the PR-status
        // observation path. A PR workflow run and its commit statuses are
        // two evidence sources for one lifecycle change, not two changes.
        title: pullRequest
          ? `PR #${pullRequest.number} · ${workspaceName}`
          : `${workspaceName} export`,
        summary:
          pullRequest?.title ?? `GitHub Actions evidence for ${repository}`,
        // References are observations, not create-request identity. Keeping
        // them out of the idempotency payload lets later attempts append
        // evidence to the same PR/branch change without conflicts.
        initialReferences: [],
      },
      {
        origin: 'github-actions',
        externalChangeKey,
        associations,
        scope: pullRequestNumber ? 'pull_request' : 'branch',
        externalStatus,
        occurredAt:
          group
            .map(item => item.run.created_at)
            .filter((value): value is string => Boolean(value))
            .sort()[0] ??
          firstRun.updated_at ??
          new Date().toISOString(),
      },
    );
    const successful = group
      .filter(
        matching =>
          matching.job.status === 'completed' &&
          matching.job.conclusion === 'success',
      )
      .sort((left, right) => {
        const leftTime = Date.parse(
          left.run.updated_at ?? left.run.created_at ?? '',
        );
        const rightTime = Date.parse(
          right.run.updated_at ?? right.run.created_at ?? '',
        );
        return (
          rightTime - leftTime ||
          (right.run.run_attempt ?? 1) - (left.run.run_attempt ?? 1) ||
          right.run.id - left.run.id
        );
      });
    const winning = successful[0];
    let winningRunPayload: CiRun | undefined;
    let winningSnapshotEventId: string | undefined;
    for (const matching of group) {
      const reference = runReference(matching.run);
      if (reference) {
        const referenceOccurredAt =
          matching.run.updated_at ??
          matching.run.created_at ??
          new Date().toISOString();
        await service.recordSystemEvent({
          eventId: eventId([
            externalChangeKey,
            'reference',
            reference.externalId ?? reference.url,
            referenceOccurredAt,
            reference.title,
            reference.url,
          ]),
          changeId: change.change.changeId,
          occurredAt: referenceOccurredAt,
          producer: 'github-actions-collector',
          event: { kind: 'reference.linked', reference },
        });
        totalEvents += 1;
      }
    }
    for (const { run, job } of group) {
      const occurredAt =
        run.updated_at ?? run.created_at ?? new Date().toISOString();
      const runPayload: CiRun = {
        provider: 'github-actions',
        repository,
        workflow: run.name ?? run.path ?? 'workflow',
        workflowFile: run.path,
        runId: String(run.id),
        runNumber: run.run_number,
        runAttempt: run.run_attempt ?? 1,
        jobId: String(job.id),
        jobName: job.name,
        workspace: workspaceName,
        eventName: run.event,
        branch: run.head_branch ?? undefined,
        pullRequestNumber,
        commitSha: run.head_sha,
        sourceRepository: overlay.metadata.annotations?.[SOURCE_REPOSITORY],
        sourceCommitSha:
          overlay.metadata.annotations?.[SOURCE_SHA] ??
          overlay.metadata.annotations?.[LEGACY_SOURCE_SHA],
        status: job.status,
        conclusion: conclusion(job.conclusion ?? run.conclusion),
        startedAt: job.started_at ?? undefined,
        completedAt: job.completed_at ?? undefined,
        updatedAt: run.updated_at ?? undefined,
        url: job.html_url ?? run.html_url,
        winning: false,
        fixture: false,
      };
      // Include the complete normalized observation in the id. GitHub can
      // revise job timestamps, URLs, and conclusions after a run is first
      // observed; a changed payload must become a new append-only event,
      // while an identical observation remains idempotent.
      const snapshotEventId = eventId([
        repository,
        workspaceName,
        String(run.id),
        String(run.run_attempt ?? 1),
        String(job.id),
        JSON.stringify(runPayload),
      ]);
      await service.recordSystemEvent({
        eventId: snapshotEventId,
        changeId: change.change.changeId,
        occurredAt,
        producer: 'github-actions-collector',
        event: {
          kind: 'ci.run.recorded',
          run: runPayload,
        },
      });
      totalEvents += 1;
      if (
        winning &&
        winning.run.id === run.id &&
        winning.job.id === job.id &&
        (winning.run.run_attempt ?? 1) === (run.run_attempt ?? 1)
      ) {
        winningRunPayload = runPayload;
        winningSnapshotEventId = snapshotEventId;
      }
      let phase: {
        phase: 'build';
        state: 'pending' | 'running' | 'blocked' | 'failed' | 'succeeded';
        summary: string;
        blocker?: string;
      };
      if (job.status === 'completed' && job.conclusion === 'success') {
        phase = {
          phase: 'build',
          state: 'succeeded',
          summary: `Export job ${job.name} succeeded`,
        };
      } else if (job.status === 'completed') {
        phase = {
          phase: 'build',
          state:
            job.conclusion === 'cancelled' ||
            job.conclusion === 'skipped' ||
            job.conclusion === 'neutral' ||
            job.conclusion === 'action_required'
              ? 'blocked'
              : 'failed',
          summary: `Export job ${job.name} did not succeed`,
          blocker: `GitHub Actions conclusion: ${
            job.conclusion ?? run.conclusion ?? 'unknown'
          }`,
        };
      } else {
        phase = {
          phase: 'build',
          state: job.status === 'queued' ? 'pending' : 'running',
          summary:
            job.status === 'queued'
              ? `Export job ${job.name} is queued`
              : `Export job ${job.name} is running`,
        };
      }
      await service.recordSystemEvent({
        eventId: eventId([snapshotEventId, 'phase']),
        changeId: change.change.changeId,
        occurredAt,
        producer: 'github-actions-collector',
        event: { kind: 'phase.updated', ...phase },
      });
      totalEvents += 1;
    }

    if (winning) {
      const packageRefs = annotationRefs(overlay, PACKAGE_REFS);
      const runAttempt = winning.run.run_attempt ?? 1;
      let validPackageCount = 0;
      if (requireManifest) {
        const manifestKey = `${repository}:${winning.run.id}:${runAttempt}`;
        let manifest = cache.manifests.get(manifestKey);
        if (!cache.manifests.has(manifestKey)) {
          try {
            manifest = reader.getLifecycleManifest
              ? await reader.getLifecycleManifest(
                  repository,
                  winning.run.id,
                  runAttempt,
                )
              : undefined;
          } catch (error) {
            await service.recordSystemDiagnostic({
              source: 'github-actions',
              subjectEntityRef: overlayRef,
              externalId: `${winning.run.id}:${runAttempt}`,
              reasonCode: 'publication-manifest-invalid',
              summary:
                error instanceof Error
                  ? error.message
                  : 'Lifecycle manifest could not be validated',
              details: { repository, workflow: workflowFile },
            });
          }
          cache.manifests.set(manifestKey, manifest);
        }
        if (manifest) {
          for (const packageRef of packageRefs) {
            const entry = manifest.packages.find(
              candidate => candidate.packageEntityRef === packageRef,
            );
            if (!entry || entry.workspace !== workspaceName) {
              await service.recordSystemDiagnostic({
                source: 'github-actions',
                subjectEntityRef: overlayRef,
                externalId: packageRef,
                reasonCode: 'manifest-package-missing',
                summary: `Lifecycle manifest does not contain ${packageRef} for workspace ${workspaceName}`,
                details: { repository, runId: winning.run.id },
              });
              continue;
            }
            const digest = artifactDigest(entry.ociReference);
            if (!digest || digest !== entry.ociDigest) {
              await service.recordSystemDiagnostic({
                source: 'github-actions',
                subjectEntityRef: overlayRef,
                externalId: packageRef,
                reasonCode: 'manifest-artifact-invalid',
                summary: `Lifecycle manifest artifact for ${packageRef} is not digest-pinned`,
                details: { reference: entry.ociReference },
              });
              continue;
            }
            await recordArtifactEvent(
              service,
              change.change.changeId,
              externalChangeKey,
              winning,
              {
                packageRef,
                name: entry.packageName,
                version: entry.version,
                reference: entry.ociReference,
                digest,
              },
            );
            totalEvents += 1;
            validPackageCount += 1;
          }
        } else {
          await service.recordSystemDiagnostic({
            source: 'github-actions',
            subjectEntityRef: overlayRef,
            externalId: `${winning.run.id}:${runAttempt}`,
            reasonCode: 'publication-manifest-unavailable',
            summary:
              'Workflow succeeded, but publication remains pending until its lifecycle manifest is ingested',
            details: {
              repository,
              workflow: workflowFile,
              runId: winning.run.id,
              runAttempt,
            },
          });
        }
      } else {
        // Current Extensions Catalog metadata is the released baseline, not
        // proof that this workflow run produced the same artifact. Keep it
        // out of the change projection unless a run-scoped manifest is
        // explicitly enabled.
        validPackageCount = 0;
      }
      if (
        requireManifest &&
        packageRefs.length > 0 &&
        validPackageCount === packageRefs.length
      ) {
        if (winningRunPayload && winningSnapshotEventId) {
          await service.recordSystemEvent({
            eventId: eventId([winningSnapshotEventId, 'winner']),
            changeId: change.change.changeId,
            occurredAt:
              winning.run.updated_at ??
              winning.run.created_at ??
              new Date().toISOString(),
            producer: 'github-actions-collector',
            event: {
              kind: 'ci.run.recorded',
              run: { ...winningRunPayload, winning: true },
            },
          });
          totalEvents += 1;
        }
        await service.recordSystemEvent({
          eventId: eventId([
            repository,
            workspaceName,
            externalChangeKey,
            'published',
            winning.run.updated_at ?? winning.run.created_at ?? '',
          ]),
          changeId: change.change.changeId,
          occurredAt:
            winning.run.updated_at ??
            winning.run.created_at ??
            new Date().toISOString(),
          producer: 'github-actions-collector',
          event: {
            kind: 'phase.updated',
            phase: 'publication',
            state: 'succeeded',
            summary: `Published ${validPackageCount} package${
              validPackageCount === 1 ? '' : 's'
            }`,
          },
        });
        totalEvents += 1;
      } else if (requireManifest && packageRefs.length > 0) {
        await service.recordSystemEvent({
          eventId: eventId([
            externalChangeKey,
            String(winning.run.id),
            String(winning.run.run_attempt ?? 1),
            'publication-pending',
            winning.run.updated_at ?? winning.run.created_at ?? '',
          ]),
          changeId: change.change.changeId,
          occurredAt:
            winning.run.updated_at ??
            winning.run.created_at ??
            new Date().toISOString(),
          producer: 'github-actions-collector',
          event: {
            kind: 'phase.updated',
            phase: 'publication',
            state: 'pending',
            summary:
              'Build succeeded; waiting for digest-pinned package evidence',
          },
        });
        totalEvents += 1;
      }
    }
  }
  await updateSyncState(overlayRef, {
    status: 'succeeded',
    lastAttemptAt: new Date().toISOString(),
    lastSuccessAt: new Date().toISOString(),
  });
  return {
    changes: groups.size + pullRequestResult.changes,
    events: totalEvents + pullRequestResult.events,
  };
}
