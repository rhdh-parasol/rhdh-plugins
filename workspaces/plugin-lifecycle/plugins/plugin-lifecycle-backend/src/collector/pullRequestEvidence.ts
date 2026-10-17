/*
 * Copyright Red Hat, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 */
import type { Entity } from '@backstage/catalog-model';
import type { LifecycleService } from '../service/LifecycleService';
import {
  cachedValue,
  catalogEntityRef,
  commitStatusRun,
  eventId,
  latestStatus,
  mapWithConcurrency,
  pullRequestExternalStatus,
  pullRequestNumberForChange,
  statusPhaseState,
  slug,
  touchesWorkspace,
  workspace,
  type CollectionCache,
} from './collectorHelpers';
import type { GitHubActionsReader, GitHubPullRequest } from './githubReader';

export const GITHUB_REQUEST_CONCURRENCY = 8;
export const MAX_CLOSED_PULL_REQUESTS_PER_REPOSITORY = 100;

export async function collectPullRequestEvidence(input: {
  overlay: Entity;
  cache: CollectionCache;
  reader: GitHubActionsReader;
  service: LifecycleService;
  closedPullRequestsPerWorkspace: number;
}): Promise<{ changes: number; events: number }> {
  const { overlay, cache, reader, service, closedPullRequestsPerWorkspace } =
    input;
  if (
    (!reader.listOpenPullRequests && !reader.listClosedPullRequests) ||
    !reader.listPullRequestFiles ||
    !reader.getCommitStatuses
  ) {
    return { changes: 0, events: 0 };
  }
  const repository = slug(overlay);
  if (!repository) return { changes: 0, events: 0 };
  const workspaceName = workspace(overlay);
  const closedPullRequestQuota = Math.max(
    0,
    Math.min(100, Math.floor(closedPullRequestsPerWorkspace)),
  );
  const openPullRequestsKey = `${repository}:open`;
  const openPullRequests = await cachedValue(
    cache,
    `pullRequests:${openPullRequestsKey}`,
    cache.pullRequests,
    () =>
      reader.listOpenPullRequests
        ? reader.listOpenPullRequests(repository)
        : Promise.resolve([]),
  );
  cache.pullRequests.set(openPullRequestsKey, openPullRequests);
  const closedPullRequestsKey = `${repository}:closed`;
  let closedPullRequests: GitHubPullRequest[] = [];
  if (closedPullRequestQuota > 0) {
    closedPullRequests = await cachedValue(
      cache,
      `pullRequests:${closedPullRequestsKey}`,
      cache.pullRequests,
      async () =>
        (reader.listClosedPullRequests
          ? await reader.listClosedPullRequests(repository)
          : []
        )
          .slice()
          .sort(
            (left, right) =>
              (Date.parse(right.updated_at ?? '') || 0) -
              (Date.parse(left.updated_at ?? '') || 0),
          )
          .slice(0, MAX_CLOSED_PULL_REQUESTS_PER_REPOSITORY),
    );
    cache.pullRequests.set(closedPullRequestsKey, closedPullRequests);
  }
  // A PR can only be in one state at a time, but keeping the open response
  // first makes the merge deterministic if GitHub changes state between
  // the two repository-level requests.
  const pullRequestsByNumber = new Map<number, GitHubPullRequest>();
  for (const pullRequest of openPullRequests) {
    pullRequestsByNumber.set(pullRequest.number, pullRequest);
  }
  for (const pullRequest of closedPullRequests) {
    if (!pullRequestsByNumber.has(pullRequest.number)) {
      pullRequestsByNumber.set(pullRequest.number, pullRequest);
    }
  }
  const pullRequests = [...pullRequestsByNumber.values()];
  const openPullRequestNumbers = new Set(
    openPullRequests.map(pullRequest => pullRequest.number),
  );
  const findMatchingPullRequests = async (
    candidates: GitHubPullRequest[],
    limit = Number.POSITIVE_INFINITY,
  ): Promise<GitHubPullRequest[]> => {
    const matching: GitHubPullRequest[] = [];
    // Closed PRs are already sorted most-recent-first. Stop after the
    // workspace quota so a sparse workspace does not require file requests
    // for the entire repository history. Open PRs use Infinity and are all
    // checked so every active candidate remains visible.
    for (
      let offset = 0;
      offset < candidates.length && matching.length < limit;
      offset += GITHUB_REQUEST_CONCURRENCY
    ) {
      const batch = candidates.slice(
        offset,
        offset + GITHUB_REQUEST_CONCURRENCY,
      );
      const batchMatches = await mapWithConcurrency(
        batch,
        GITHUB_REQUEST_CONCURRENCY,
        async pullRequest => {
          const filesKey = `${repository}:${pullRequest.number}`;
          const files = await cachedValue(
            cache,
            `pullRequestFiles:${filesKey}`,
            cache.pullRequestFiles,
            () => reader.listPullRequestFiles!(repository, pullRequest.number),
          );
          return touchesWorkspace(files, workspaceName)
            ? pullRequest
            : undefined;
        },
      );
      matching.push(
        ...batchMatches.filter(
          (pullRequest): pullRequest is GitHubPullRequest =>
            Boolean(pullRequest),
        ),
      );
    }
    return matching.slice(0, limit);
  };
  const matchingClosedPullRequests =
    closedPullRequestQuota > 0
      ? await findMatchingPullRequests(
          closedPullRequests.filter(
            pullRequest => !openPullRequestNumbers.has(pullRequest.number),
          ),
          closedPullRequestQuota,
        )
      : [];
  const matchingOpenPullRequests = await findMatchingPullRequests(
    pullRequests.filter(
      pullRequest => pullRequestExternalStatus(pullRequest) === 'open',
    ),
  );
  const matchingPullRequests = [
    ...matchingOpenPullRequests,
    ...matchingClosedPullRequests.slice(0, closedPullRequestQuota),
  ];
  if (
    closedPullRequestQuota > 0 &&
    closedPullRequests.length >= MAX_CLOSED_PULL_REQUESTS_PER_REPOSITORY &&
    matchingClosedPullRequests.length < closedPullRequestQuota
  ) {
    await service.recordSystemDiagnostic({
      source: 'github-actions',
      subjectEntityRef: catalogEntityRef(overlay),
      externalId: `${repository}:${workspaceName}:closed-pr-cap`,
      reasonCode: 'closed-pr-history-cap',
      summary: `Closed PR history scan reached the repository cap before finding ${closedPullRequestQuota} PRs for workspace ${workspaceName}`,
      details: {
        repository,
        workspace: workspaceName,
        repositoryCap: MAX_CLOSED_PULL_REQUESTS_PER_REPOSITORY,
        matchingClosedPullRequests: matchingClosedPullRequests.length,
      },
    });
  }
  const associations = await service.associationsForEntity(overlay);
  let changes = 0;
  let events = 0;
  const lifecycleService = service as LifecycleService & {
    getChangeDetails?: LifecycleService['getChangeDetails'];
    updateSystemChangeStatus?: LifecycleService['updateSystemChangeStatus'];
  };
  if (
    lifecycleService.getChangeDetails &&
    lifecycleService.updateSystemChangeStatus
  ) {
    const existingChanges = await lifecycleService.getChangeDetails(
      catalogEntityRef(overlay),
    );
    for (const existingChange of existingChanges) {
      if (
        existingChange.summary.origin !== 'github-actions' ||
        existingChange.summary.scope !== 'pull_request' ||
        existingChange.summary.externalStatus !== 'open'
      ) {
        continue;
      }
      const pullRequestNumber = pullRequestNumberForChange(
        existingChange,
        workspaceName,
      );
      if (pullRequestNumber && !openPullRequestNumbers.has(pullRequestNumber)) {
        await lifecycleService.updateSystemChangeStatus(
          existingChange.summary.changeId,
          'closed',
        );
      }
    }
  }
  for (const pullRequest of matchingPullRequests) {
    const headSha = pullRequest.head?.sha;
    if (!headSha) continue;
    const statusKey = `${repository}:${headSha}`;
    const statuses = await cachedValue(
      cache,
      `commitStatuses:${statusKey}`,
      cache.commitStatuses,
      () => reader.getCommitStatuses!(repository, headSha),
    );
    const publish = latestStatus(statuses, 'publish');
    const smoke = latestStatus(statuses, 'smoketest');
    const sourceKey = `${repository}:${workspaceName}:${headSha}`;
    let source = cache.workspaceSources.get(sourceKey);
    if (!cache.workspaceSources.has(sourceKey) && reader.getWorkspaceSource) {
      try {
        source = await cachedValue(
          cache,
          `workspaceSources:${sourceKey}`,
          cache.workspaceSources,
          () => reader.getWorkspaceSource!(repository, workspaceName, headSha),
        );
      } catch (error) {
        await service.recordSystemDiagnostic({
          source: 'github-actions',
          subjectEntityRef: catalogEntityRef(overlay),
          externalId: sourceKey,
          reasonCode: 'source-metadata-unavailable',
          summary:
            error instanceof Error
              ? error.message
              : 'Workspace source metadata could not be read',
          details: { repository, workspace: workspaceName, ref: headSha },
        });
      }
      cache.workspaceSources.set(sourceKey, source);
    }
    const occurredAt =
      pullRequest.updated_at ??
      publish?.updated_at ??
      smoke?.updated_at ??
      new Date().toISOString();
    const externalChangeKey = `github:${repository}:pr:${pullRequest.number}:workspace:${workspaceName}`;
    const externalStatus = pullRequestExternalStatus(pullRequest);
    const change = await service.createSystemChange(
      {
        requestId: externalChangeKey,
        subjectEntityRef: catalogEntityRef(overlay),
        title: `PR #${pullRequest.number} · ${workspaceName}`,
        summary: pullRequest.title,
        initialReferences: [],
      },
      {
        origin: 'github-actions',
        externalChangeKey,
        associations,
        scope: 'pull_request',
        externalStatus,
        occurredAt: pullRequest.created_at ?? occurredAt,
      },
    );
    if (lifecycleService.updateSystemChangeStatus) {
      await lifecycleService.updateSystemChangeStatus(
        change.change.changeId,
        externalStatus,
      );
    }
    changes += 1;
    const pullRequestUrl =
      pullRequest.html_url ??
      `https://github.com/${repository}/pull/${pullRequest.number}`;
    await service.recordSystemEvent({
      eventId: eventId([externalChangeKey, 'pull-request', occurredAt]),
      changeId: change.change.changeId,
      occurredAt,
      producer: 'github-actions-collector',
      event: {
        kind: 'reference.linked',
        reference: {
          type: 'pull_request',
          externalId: String(pullRequest.number),
          title: pullRequest.title,
          url: pullRequestUrl,
          author: pullRequest.user?.login,
          updatedAt: pullRequest.updated_at,
        },
      },
    });
    events += 1;
    const sourceReference = {
      type: 'source' as const,
      externalId: source?.revision ?? headSha,
      title: source
        ? `Source revision ${source.revision.slice(0, 12)}`
        : `Overlay revision ${headSha.slice(0, 12)}`,
      url: source
        ? `https://github.com/${source.repository}/commit/${source.revision}`
        : `https://github.com/${repository}/commit/${headSha}`,
    };
    await service.recordSystemEvent({
      eventId: eventId([externalChangeKey, 'source', headSha, occurredAt]),
      changeId: change.change.changeId,
      occurredAt,
      producer: 'github-actions-collector',
      event: { kind: 'reference.linked', reference: sourceReference },
    });
    events += 1;
    for (const status of [publish, smoke]) {
      if (!status) continue;
      const statusRun = commitStatusRun({
        repository,
        workspace: workspaceName,
        pullRequestNumber: pullRequest.number,
        headSha,
        status,
        source,
      });
      await service.recordSystemEvent({
        eventId: eventId([
          externalChangeKey,
          'commit-status',
          status.context,
          status.state,
          status.updated_at ?? '',
        ]),
        changeId: change.change.changeId,
        occurredAt: status.updated_at ?? occurredAt,
        producer: 'github-actions-collector',
        event: { kind: 'ci.run.recorded', run: statusRun },
      });
      events += 1;
    }
    const publishPhase = statusPhaseState(publish);
    if (publishPhase) {
      await service.recordSystemEvent({
        eventId: eventId([
          externalChangeKey,
          'publish',
          publish?.state ?? 'unknown',
          publish?.updated_at ?? '',
        ]),
        changeId: change.change.changeId,
        occurredAt: publish?.updated_at ?? occurredAt,
        producer: 'github-actions-collector',
        event: {
          kind: 'phase.updated',
          phase: 'build',
          ...publishPhase,
        },
      });
      events += 1;
    }
    const smokePhase = statusPhaseState(smoke);
    if (smokePhase) {
      await service.recordSystemEvent({
        eventId: eventId([
          externalChangeKey,
          'smoketest',
          smoke?.state ?? 'unknown',
          smoke?.updated_at ?? '',
        ]),
        changeId: change.change.changeId,
        occurredAt: smoke?.updated_at ?? occurredAt,
        producer: 'github-actions-collector',
        event: {
          kind: 'phase.updated',
          phase: 'verification',
          ...smokePhase,
        },
      });
      events += 1;
    }
    if (publish?.state === 'success' && reader.getPublishedExports) {
      const artifactKey = `${repository}:${pullRequest.number}`;
      let published = cache.publishedExports.get(artifactKey);
      if (!cache.publishedExports.has(artifactKey)) {
        try {
          published = await reader.getPublishedExports(
            repository,
            pullRequest.number,
          );
        } catch (error) {
          await service.recordSystemDiagnostic({
            source: 'github-actions',
            subjectEntityRef: catalogEntityRef(overlay),
            externalId: artifactKey,
            reasonCode: 'published-exports-invalid',
            summary: error instanceof Error ? error.message : String(error),
            details: { repository, workspace: workspaceName },
          });
        }
        cache.publishedExports.set(artifactKey, published);
      }
      if (!published) {
        await service.recordSystemDiagnostic({
          source: 'github-actions',
          subjectEntityRef: catalogEntityRef(overlay),
          externalId: artifactKey,
          reasonCode: 'published-exports-unavailable',
          summary:
            'The successful publish check has no retained candidate image artifact (it may have expired)',
          details: { repository, workspace: workspaceName },
        });
      }
      if (
        published &&
        (published.workspace !== workspaceName ||
          published.overlayCommit !== headSha)
      ) {
        await service.recordSystemDiagnostic({
          source: 'github-actions',
          subjectEntityRef: catalogEntityRef(overlay),
          externalId: artifactKey,
          reasonCode: 'published-exports-metadata-mismatch',
          summary:
            'Published exports metadata does not match the requested workspace or PR revision',
          details: {
            repository,
            workspace: workspaceName,
            expectedCommit: headSha,
            artifactWorkspace: published.workspace,
            artifactCommit: published.overlayCommit,
          },
        });
        published = undefined;
      }
      for (const image of published?.images ?? []) {
        const imageOccurredAt = publish?.updated_at ?? occurredAt;
        await service.recordSystemEvent({
          eventId: eventId([
            externalChangeKey,
            'candidate-image',
            image,
            imageOccurredAt,
          ]),
          changeId: change.change.changeId,
          occurredAt: imageOccurredAt,
          producer: 'github-actions-collector',
          event: {
            kind: 'artifact.recorded',
            artifact: { artifactType: 'oci', reference: image },
          },
        });
        events += 1;
      }
    }
  }
  return { changes, events };
}
