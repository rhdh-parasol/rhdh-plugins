/*
 * Copyright Red Hat, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 */
import { createHash } from 'crypto';
import type { Entity } from '@backstage/catalog-model';
import {
  type CiRun,
  type LifecycleReference,
} from '@red-hat-developer-hub/backstage-plugin-lifecycle-common';
import type { LifecycleService } from '../service/LifecycleService';
import { GitHubRequestError } from './githubClient';
import type {
  GitHubCommitStatus,
  GitHubPullRequest,
  GitHubWorkflowJob,
  GitHubWorkflowRun,
  GitHubWorkspaceSource,
  LifecycleManifest,
  PublishedExports,
} from './githubReader';

const PROJECT_SLUG = 'github.com/project-slug';
const WORKSPACE = 'rhdh.io/overlay-workspace';
const REPOSITORY_SLUG = /^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/;

export interface CollectionCache {
  runs: Map<string, GitHubWorkflowRun[]>;
  jobs: Map<string, GitHubWorkflowJob[]>;
  manifests: Map<string, LifecycleManifest | undefined>;
  pullRequests: Map<string, GitHubPullRequest[]>;
  pullRequestFiles: Map<string, string[]>;
  commitStatuses: Map<string, GitHubCommitStatus[]>;
  publishedExports: Map<string, PublishedExports | undefined>;
  workspaceSources: Map<string, GitHubWorkspaceSource | undefined>;
  pending: Map<string, Promise<unknown>>;
}

export function newCollectionCache(): CollectionCache {
  return {
    runs: new Map(),
    jobs: new Map(),
    manifests: new Map(),
    pullRequests: new Map(),
    pullRequestFiles: new Map(),
    commitStatuses: new Map(),
    publishedExports: new Map(),
    workspaceSources: new Map(),
    pending: new Map(),
  };
}

/** Shares one repository request between concurrent subject refreshes. */
export async function cachedValue<T>(
  cache: CollectionCache,
  key: string,
  target: Map<string, T>,
  loader: () => Promise<T>,
): Promise<T> {
  if (target.has(key)) return target.get(key) as T;
  const pending = cache.pending.get(key) as Promise<T> | undefined;
  if (pending) return pending;
  const request = loader().then(
    value => {
      target.set(key, value);
      cache.pending.delete(key);
      return value;
    },
    error => {
      cache.pending.delete(key);
      throw error;
    },
  );
  cache.pending.set(key, request);
  return request;
}

export interface Deferred {
  promise: Promise<boolean>;
  resolve: (success: boolean) => void;
  reject: (error: unknown) => void;
}

export interface MatchingJob {
  run: GitHubWorkflowRun;
  job: GitHubWorkflowJob;
}

export function pullRequestNumberForChange(
  change: {
    summary: { externalChangeKey?: string };
  },
  workspaceName: string,
): number | undefined {
  const key = change.summary.externalChangeKey;
  if (!key) return undefined;
  const match = key.match(/^github:[^:]+(?:\/[^:]+)?:pr:(\d+):workspace:(.+)$/);
  return match?.[2] === workspaceName
    ? Number.parseInt(match[1], 10)
    : undefined;
}

export function deferred(): Deferred {
  let resolve!: (success: boolean) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<boolean>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export function slug(entity: Entity): string | undefined {
  const value = entity.metadata.annotations?.[PROJECT_SLUG];
  const slugValue = value?.trim();
  return slugValue && REPOSITORY_SLUG.test(slugValue) ? slugValue : undefined;
}

export function isOverlay(entity: Entity): boolean {
  return (
    entity.kind.toLocaleLowerCase('en-US') === 'component' &&
    entity.spec?.type === 'rhdh-overlay-workspace'
  );
}

export function workspace(entity: Entity): string {
  const annotated = entity.metadata.annotations?.[WORKSPACE]?.trim();
  if (annotated) return annotated;

  // PR #4 descriptors predate the explicit workspace annotation. Their
  // generated entity name is canonically `overlay-<workspace>`, so retain
  // compatibility with those live Catalog entities while preferring the
  // annotation for newer descriptors.
  const name = entity.metadata.name;
  return name.startsWith('overlay-') ? name.slice('overlay-'.length) : name;
}

export function annotationRefs(entity: Entity, key: string): string[] {
  return (entity.metadata.annotations?.[key] ?? '')
    .split(',')
    .map(ref => ref.trim())
    .filter(Boolean);
}

export function catalogEntityRef(entity: Entity): string {
  return `${entity.kind.toLocaleLowerCase('en-US')}:${
    entity.metadata.namespace ?? 'default'
  }/${entity.metadata.name}`;
}

export function artifactDigest(reference: unknown): string | undefined {
  if (typeof reference !== 'string') return undefined;
  return reference.match(/@(?<digest>sha256:[a-f0-9]{64})$/)?.groups?.digest;
}

export function rateLimitResetAt(error: unknown): string | undefined {
  if (!(error instanceof GitHubRequestError)) return undefined;
  if (error.rateLimitReset) {
    const epochSeconds = Number(error.rateLimitReset);
    if (Number.isFinite(epochSeconds)) {
      return new Date(epochSeconds * 1000).toISOString();
    }
  }
  if (error.retryAfter) {
    const delaySeconds = Number(error.retryAfter);
    if (Number.isFinite(delaySeconds)) {
      return new Date(Date.now() + delaySeconds * 1000).toISOString();
    }
  }
  return undefined;
}

export function eventId(parts: string[]): string {
  return `github-actions:${createHash('sha256')
    .update(parts.join('|'))
    .digest('hex')}`;
}

export function pullRequestExternalStatus(
  pullRequest: GitHubPullRequest,
): 'open' | 'merged' | 'closed' {
  if (pullRequest.merged_at) return 'merged';
  if (pullRequest.state === 'closed' || pullRequest.closed_at) return 'closed';
  return 'open';
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function touchesWorkspace(
  files: string[],
  workspaceName: string,
): boolean {
  const prefix = `workspaces/${workspaceName}/`;
  return files.some(
    file => file === `workspaces/${workspaceName}` || file.startsWith(prefix),
  );
}

/** Run independent GitHub reads in parallel without creating an unbounded burst. */
export async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  map: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (values.length === 0) return [];
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    while (nextIndex < values.length) {
      const index = nextIndex++;
      results[index] = await map(values[index], index);
    }
  };
  const workerCount = Math.min(
    Math.max(1, Math.floor(concurrency)),
    values.length,
  );
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

export function latestStatus(
  statuses: GitHubCommitStatus[],
  context: string,
): GitHubCommitStatus | undefined {
  return statuses
    .filter(status => status.context === context)
    .sort(
      (left, right) =>
        Date.parse(right.updated_at ?? '') - Date.parse(left.updated_at ?? ''),
    )[0];
}

export function statusPhaseState(status: GitHubCommitStatus | undefined):
  | {
      state: 'pending' | 'running' | 'failed' | 'succeeded';
      summary: string;
      blocker?: string;
      evidenceUrl?: string;
    }
  | undefined {
  if (!status) return undefined;
  if (status.state === 'pending') {
    return {
      state: 'pending',
      summary: status.description ?? 'GitHub check is pending',
      evidenceUrl: status.target_url ?? undefined,
    };
  }
  if (status.state === 'success') {
    return {
      state: 'succeeded',
      summary: status.description ?? 'GitHub check succeeded',
      evidenceUrl: status.target_url ?? undefined,
    };
  }
  if (status.state === 'error' || status.state === 'failure') {
    return {
      state: 'failed',
      summary: status.description ?? 'GitHub check failed',
      blocker: status.description ?? 'GitHub check failed',
      evidenceUrl: status.target_url ?? undefined,
    };
  }
  return {
    state: 'running',
    summary: 'GitHub check is running',
    evidenceUrl: status.target_url ?? undefined,
  };
}

export function commitStatusRun(input: {
  repository: string;
  workspace: string;
  pullRequestNumber: number;
  headSha: string;
  status: GitHubCommitStatus;
  source?: GitHubWorkspaceSource;
}): CiRun {
  const { status } = input;
  let statusConclusion: CiRun['conclusion'];
  if (status.state === 'success') statusConclusion = 'success';
  if (status.state === 'error' || status.state === 'failure') {
    statusConclusion = 'failure';
  }
  return {
    provider: 'github-commit-status',
    repository: input.repository,
    workflow: 'GitHub commit status',
    runId: `${input.headSha}:${status.context}`,
    runAttempt: 1,
    jobName: status.context,
    workspace: input.workspace,
    pullRequestNumber: input.pullRequestNumber,
    commitSha: input.headSha,
    sourceRepository: input.source?.repository,
    sourceCommitSha: input.source?.revision,
    status: status.state === 'pending' ? 'in_progress' : 'completed',
    conclusion: statusConclusion,
    updatedAt: status.updated_at,
    url: status.target_url ?? undefined,
    winning: false,
    fixture: false,
  };
}

export function conclusion(
  value: string | null | undefined,
):
  | 'success'
  | 'failure'
  | 'cancelled'
  | 'skipped'
  | 'timed_out'
  | 'neutral'
  | 'action_required'
  | undefined {
  if (!value) return undefined;
  const supported = [
    'success',
    'failure',
    'cancelled',
    'skipped',
    'timed_out',
    'neutral',
    'action_required',
  ] as const;
  return (supported as readonly string[]).includes(value)
    ? (value as (typeof supported)[number])
    : 'failure';
}

export function runReference(
  run: GitHubWorkflowRun,
): LifecycleReference | undefined {
  if (!run.html_url) return undefined;
  return {
    type: 'workflow',
    externalId: String(run.id),
    title: `${run.name ?? 'GitHub Actions'} #${run.run_number}`,
    url: run.html_url,
  };
}

export async function recordArtifactEvent(
  service: LifecycleService,
  changeId: string,
  externalChangeKey: string,
  winning: MatchingJob,
  input: {
    packageRef: string;
    name: string;
    version: string;
    reference: string;
    digest: string;
  },
): Promise<void> {
  const runAttempt = winning.run.run_attempt ?? 1;
  const occurredAt =
    winning.run.updated_at ??
    winning.run.created_at ??
    new Date().toISOString();
  await service.recordSystemEvent({
    eventId: eventId([
      externalChangeKey,
      String(winning.run.id),
      String(runAttempt),
      input.packageRef,
      input.digest,
      occurredAt,
    ]),
    changeId,
    occurredAt,
    producer: 'github-actions-collector',
    event: {
      kind: 'artifact.recorded',
      artifact: {
        artifactType: 'oci',
        packageEntityRef: input.packageRef,
        name: input.name,
        version: input.version,
        reference: input.reference,
        digest: input.digest,
        runId: String(winning.run.id),
        jobId: String(winning.job.id),
      },
    },
  });
}
