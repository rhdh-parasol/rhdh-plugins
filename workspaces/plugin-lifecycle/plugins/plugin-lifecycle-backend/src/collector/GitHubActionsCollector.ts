/*
 * Copyright Red Hat, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
import { createHash } from 'crypto';
import type { AuthService, LoggerService } from '@backstage/backend-plugin-api';
import type { Entity } from '@backstage/catalog-model';
import type { GithubCredentialsProvider } from '@backstage/integration';
import type { CatalogService } from '@backstage/plugin-catalog-node';
import JSZip from 'jszip';
import { z } from 'zod/v3';
import {
  type CiRun,
  type LifecycleReference,
} from '@red-hat-developer-hub/backstage-plugin-lifecycle-common';
import type { LifecycleService } from '../service/LifecycleService';

const PROJECT_SLUG = 'github.com/project-slug';
const WORKSPACE = 'rhdh.io/overlay-workspace';
const SOURCE_SHA = 'rhdh.io/source-revision';
const LEGACY_SOURCE_SHA = 'rhdh.io/source-commit-sha';
const SOURCE_REPOSITORY = 'rhdh.io/source-repository';
const PACKAGE_REFS = 'rhdh.io/extensions-package-refs';
const PUBLISHED_EXPORTS_ARTIFACT = /^published-exports-pr-(\d+)$/;
const GITHUB_REQUEST_CONCURRENCY = 8;

export interface GitHubWorkflowRun {
  id: number;
  run_number: number;
  run_attempt?: number;
  name?: string;
  path?: string;
  event?: string;
  status: 'queued' | 'in_progress' | 'completed';
  conclusion?: string | null;
  html_url?: string;
  head_sha?: string;
  head_branch?: string | null;
  created_at?: string;
  updated_at?: string;
  run_started_at?: string | null;
  pull_requests?: Array<{ number: number }>;
}

export interface GitHubWorkflowJob {
  id: number;
  name: string;
  status: 'queued' | 'in_progress' | 'completed';
  conclusion?: string | null;
  html_url?: string;
  started_at?: string | null;
  completed_at?: string | null;
}

export interface GitHubPullRequest {
  number: number;
  title: string;
  state?: 'open' | 'closed';
  html_url?: string;
  user?: { login?: string };
  head?: { sha?: string; ref?: string };
  created_at?: string;
  updated_at?: string;
  closed_at?: string | null;
  merged_at?: string | null;
}

export interface GitHubCommitStatus {
  context: string;
  state: 'error' | 'failure' | 'pending' | 'success';
  description?: string | null;
  target_url?: string | null;
  updated_at?: string;
}

export interface PublishedExports {
  repository: string;
  workspace: string;
  overlayCommit: string;
  pullRequestNumber: number;
  targetBranch?: string;
  images: string[];
}

export interface GitHubWorkspaceSource {
  repository: string;
  revision: string;
}

export interface GitHubActionsReader {
  listRuns(
    repository: string,
    workflowFile?: string,
  ): Promise<GitHubWorkflowRun[]>;
  listJobs(
    repository: string,
    runId: number,
    runAttempt?: number,
  ): Promise<GitHubWorkflowJob[]>;
  getLifecycleManifest?(
    repository: string,
    runId: number,
    runAttempt: number,
  ): Promise<LifecycleManifest | undefined>;
  listOpenPullRequests?(repository: string): Promise<GitHubPullRequest[]>;
  /** Returns a bounded, most-recent-first list of closed pull requests. */
  listClosedPullRequests?(repository: string): Promise<GitHubPullRequest[]>;
  listPullRequestFiles?(
    repository: string,
    pullRequestNumber: number,
  ): Promise<string[]>;
  getCommitStatuses?(
    repository: string,
    commitSha: string,
  ): Promise<GitHubCommitStatus[]>;
  getPublishedExports?(
    repository: string,
    pullRequestNumber: number,
  ): Promise<PublishedExports | undefined>;
  getWorkspaceSource?(
    repository: string,
    workspaceName: string,
    ref: string,
  ): Promise<GitHubWorkspaceSource | undefined>;
}

const publishedExportsMetaSchema = z.object({
  workspace: z.string().min(1),
  overlayBranch: z.string().min(1),
  overlayRepo: z.string().min(1),
  overlayCommit: z.string().min(7),
  pr: z.number().int().positive(),
  targetBranch: z.string().min(1).optional(),
});

const lifecycleManifestPackageSchema = z.object({
  workspace: z.string().min(1),
  sourceRepository: z.string().url().optional(),
  sourceRevision: z.string().min(1).optional(),
  packageEntityRef: z.string().min(1),
  packageName: z.string().min(1),
  version: z.string().min(1),
  ociReference: z.string().min(1),
  ociDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
});

const lifecycleManifestSchema = z.object({
  schemaVersion: z.literal('1'),
  repository: z.string().min(1),
  workflow: z.string().min(1),
  runId: z.string().min(1),
  runNumber: z.number().int().positive(),
  runAttempt: z.number().int().positive(),
  event: z.string().min(1),
  ref: z.string().min(1),
  pullRequestNumber: z.number().int().positive().optional(),
  headSha: z.string().min(7),
  runUrl: z.string().url(),
  packages: z.array(lifecycleManifestPackageSchema).min(1),
});

export type LifecycleManifest = z.infer<typeof lifecycleManifestSchema>;

export class GitHubRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryAfter?: string,
    readonly rateLimitReset?: string,
  ) {
    super(message);
  }
}

/** Small fetch-based GitHub reader; authentication is supplied by the RHDH config secret. */
export class GitHubRestActionsReader implements GitHubActionsReader {
  constructor(
    private readonly credentials: string | GithubCredentialsProvider,
    private readonly apiBase = 'https://api.github.com',
  ) {}

  async listRuns(
    repository: string,
    workflowFile?: string,
  ): Promise<GitHubWorkflowRun[]> {
    const suffix = workflowFile
      ? `/actions/workflows/${encodeURIComponent(workflowFile)}/runs`
      : '/actions/runs';
    const runs: GitHubWorkflowRun[] = [];
    for (let page = 1; page <= 10 && runs.length < 100; page += 1) {
      const response = await this.fetch(
        `${this.apiBase}/repos/${repository}${suffix}?per_page=100&page=${page}`,
        repository,
      );
      const body = (await response.json()) as {
        workflow_runs?: GitHubWorkflowRun[];
      };
      const pageRuns = body.workflow_runs ?? [];
      runs.push(...pageRuns);
      if (pageRuns.length < 100) break;
    }
    return runs.slice(0, 100);
  }

  async listJobs(
    repository: string,
    runId: number,
    runAttempt = 1,
  ): Promise<GitHubWorkflowJob[]> {
    const jobs: GitHubWorkflowJob[] = [];
    for (let page = 1; page <= 10; page += 1) {
      const attemptPath = runAttempt > 1 ? `/attempts/${runAttempt}` : '';
      const response = await this.fetch(
        `${this.apiBase}/repos/${repository}/actions/runs/${runId}${attemptPath}/jobs?per_page=100&page=${page}`,
        repository,
      );
      const body = (await response.json()) as { jobs?: GitHubWorkflowJob[] };
      const pageJobs = body.jobs ?? [];
      jobs.push(...pageJobs);
      if (pageJobs.length < 100) break;
    }
    return jobs;
  }

  async listOpenPullRequests(repository: string): Promise<GitHubPullRequest[]> {
    return this.listPullRequests(repository, 'open');
  }

  async listClosedPullRequests(
    repository: string,
  ): Promise<GitHubPullRequest[]> {
    return this.listPullRequests(repository, 'closed');
  }

  private async listPullRequests(
    repository: string,
    state: 'open' | 'closed',
  ): Promise<GitHubPullRequest[]> {
    const pullRequests: GitHubPullRequest[] = [];
    for (let page = 1; page <= 5 && pullRequests.length < 100; page += 1) {
      const response = await this.fetch(
        `${this.apiBase}/repos/${repository}/pulls?state=${state}&sort=updated&direction=desc&per_page=100&page=${page}`,
        repository,
      );
      const pagePullRequests = (await response.json()) as GitHubPullRequest[];
      pullRequests.push(...pagePullRequests);
      if (pagePullRequests.length < 100) break;
    }
    return pullRequests.slice(0, 100);
  }

  async listPullRequestFiles(
    repository: string,
    pullRequestNumber: number,
  ): Promise<string[]> {
    const files: string[] = [];
    for (let page = 1; page <= 10; page += 1) {
      const response = await this.fetch(
        `${this.apiBase}/repos/${repository}/pulls/${pullRequestNumber}/files?per_page=100&page=${page}`,
        repository,
      );
      const body = (await response.json()) as Array<{ filename?: string }>;
      const pageFiles = body
        .map(file => file.filename)
        .filter((file): file is string => Boolean(file));
      files.push(...pageFiles);
      if (pageFiles.length < 100) break;
    }
    return files;
  }

  async getCommitStatuses(
    repository: string,
    commitSha: string,
  ): Promise<GitHubCommitStatus[]> {
    const statuses: GitHubCommitStatus[] = [];
    for (let page = 1; page <= 10; page += 1) {
      const response = await this.fetch(
        `${this.apiBase}/repos/${repository}/commits/${commitSha}/status?per_page=100&page=${page}`,
        repository,
      );
      const body = (await response.json()) as {
        statuses?: GitHubCommitStatus[];
      };
      const pageStatuses = body.statuses ?? [];
      statuses.push(...pageStatuses);
      if (pageStatuses.length < 100) break;
    }
    return statuses;
  }

  async getPublishedExports(
    repository: string,
    pullRequestNumber: number,
  ): Promise<PublishedExports | undefined> {
    const artifacts: Array<{
      name?: string;
      expired?: boolean;
      size_in_bytes?: number;
      digest?: string;
      archive_download_url?: string;
    }> = [];
    for (let page = 1; page <= 10; page += 1) {
      const response = await this.fetch(
        `${this.apiBase}/repos/${repository}/actions/artifacts?per_page=100&page=${page}&name=published-exports-pr-${pullRequestNumber}`,
        repository,
      );
      const body = (await response.json()) as {
        artifacts?: typeof artifacts;
      };
      const pageArtifacts = body.artifacts ?? [];
      artifacts.push(...pageArtifacts);
      if (pageArtifacts.length < 100) break;
    }
    const artifact = artifacts.find(
      candidate =>
        PUBLISHED_EXPORTS_ARTIFACT.test(candidate.name ?? '') &&
        candidate.name === `published-exports-pr-${pullRequestNumber}` &&
        !candidate.expired &&
        Boolean(candidate.archive_download_url),
    );
    if (!artifact?.archive_download_url) return undefined;
    if ((artifact.size_in_bytes ?? 0) > 1_048_576) {
      throw new Error('Published exports artifact exceeds the 1 MiB limit');
    }
    const archiveResponse = await this.fetch(
      artifact.archive_download_url,
      repository,
    );
    const archive = new Uint8Array(await archiveResponse.arrayBuffer());
    if (archive.byteLength > 1_048_576) {
      throw new Error('Published exports artifact exceeds the 1 MiB limit');
    }
    if (artifact.digest) {
      const digest = `sha256:${createHash('sha256')
        .update(archive)
        .digest('hex')}`;
      if (digest !== artifact.digest) {
        throw new Error(
          'Published exports artifact digest did not match GitHub',
        );
      }
    }
    const zip = await JSZip.loadAsync(archive);
    const entries = Object.values(zip.files);
    if (
      entries.some(
        file =>
          file.name.startsWith('/') ||
          file.name.split(/[\\/]+/).some(segment => segment === '..'),
      )
    ) {
      throw new Error(
        'Published exports artifact contains an unsafe archive path',
      );
    }
    const metaEntry = entries.find(
      file => file.name.endsWith('meta.json') && !file.dir,
    );
    const imagesEntry = entries.find(
      file => file.name.endsWith('published-exports.txt') && !file.dir,
    );
    if (!metaEntry || !imagesEntry) return undefined;
    const metadata = publishedExportsMetaSchema.parse(
      JSON.parse(await metaEntry.async('string')),
    );
    if (
      metadata.overlayRepo !== repository ||
      metadata.pr !== pullRequestNumber ||
      !PUBLISHED_EXPORTS_ARTIFACT.test(`published-exports-pr-${metadata.pr}`)
    ) {
      throw new Error('Published exports metadata does not match the PR');
    }
    const imageLines = (await imagesEntry.async('string'))
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(line => line.length > 0);
    if (imageLines.some(image => !isImageReference(image))) {
      throw new Error(
        'Published exports artifact contains an invalid image reference',
      );
    }
    return {
      repository,
      workspace: metadata.workspace.replace(/^workspaces\//, ''),
      overlayCommit: metadata.overlayCommit,
      pullRequestNumber: metadata.pr,
      targetBranch: metadata.targetBranch,
      images: imageLines,
    };
  }

  async getWorkspaceSource(
    repository: string,
    workspaceName: string,
    ref: string,
  ): Promise<GitHubWorkspaceSource | undefined> {
    const response = await this.fetch(
      `${
        this.apiBase
      }/repos/${repository}/contents/workspaces/${encodeURIComponent(
        workspaceName,
      )}/source.json?ref=${encodeURIComponent(ref)}`,
      repository,
    );
    const body = (await response.json()) as {
      content?: string;
      encoding?: string;
    };
    if (!body.content || body.encoding !== 'base64') return undefined;
    const source = JSON.parse(
      Buffer.from(body.content.replace(/\s/g, ''), 'base64').toString('utf8'),
    ) as { repo?: unknown; 'repo-ref'?: unknown };
    if (
      typeof source.repo !== 'string' ||
      typeof source['repo-ref'] !== 'string'
    )
      return undefined;
    const match = source.repo.match(
      /^https:\/\/github\.com\/([^/]+\/[^/]+)\/?$/,
    );
    const revision = source['repo-ref'].trim();
    if (!match || !revision) return undefined;
    return { repository: match[1], revision };
  }

  async getLifecycleManifest(
    repository: string,
    runId: number,
    runAttempt: number,
  ): Promise<LifecycleManifest | undefined> {
    const artifacts: Array<{
      name?: string;
      expired?: boolean;
      digest?: string;
      archive_download_url?: string;
    }> = [];
    for (let page = 1; page <= 10; page += 1) {
      const artifactsResponse = await this.fetch(
        `${this.apiBase}/repos/${repository}/actions/runs/${runId}/artifacts?per_page=100&page=${page}`,
        repository,
      );
      const body = (await artifactsResponse.json()) as {
        artifacts?: typeof artifacts;
      };
      const pageArtifacts = body.artifacts ?? [];
      artifacts.push(...pageArtifacts);
      if (pageArtifacts.length < 100) break;
    }
    const artifact = artifacts.find(
      candidate =>
        candidate.name === 'plugin-lifecycle-manifest.json' &&
        !candidate.expired &&
        Boolean(candidate.archive_download_url),
    );
    if (!artifact?.archive_download_url) return undefined;
    const archiveResponse = await this.fetch(
      artifact.archive_download_url,
      repository,
    );
    const archive = new Uint8Array(await archiveResponse.arrayBuffer());
    if (archive.byteLength > 1_048_576) {
      throw new Error('Lifecycle manifest archive exceeds the 1 MiB limit');
    }
    if (artifact.digest) {
      const digest = `sha256:${createHash('sha256')
        .update(archive)
        .digest('hex')}`;
      if (digest !== artifact.digest)
        throw new Error(
          'Lifecycle manifest archive digest did not match GitHub',
        );
    }
    const zip = await JSZip.loadAsync(archive);
    const entry = Object.values(zip.files).find(
      file => file.name.endsWith('plugin-lifecycle-manifest.json') && !file.dir,
    );
    if (!entry) return undefined;
    const content = await entry.async('string');
    if (Buffer.byteLength(content, 'utf8') > 1_048_576)
      throw new Error('Lifecycle manifest exceeds the 1 MiB limit');
    const manifest = lifecycleManifestSchema.parse(JSON.parse(content));
    if (manifest.repository !== repository || manifest.runId !== String(runId))
      throw new Error('Lifecycle manifest does not identify the requested run');
    if (manifest.runAttempt !== runAttempt)
      throw new Error('Lifecycle manifest run attempt does not match GitHub');
    return manifest;
  }

  private async fetch(url: string, repository: string): Promise<Response> {
    const token =
      typeof this.credentials === 'string'
        ? this.credentials
        : (
            await this.credentials.getCredentials({
              url: `https://github.com/${repository}`,
            })
          ).token;
    const response = await globalThis.fetch(url, {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
    if (!response.ok) {
      throw new GitHubRequestError(
        `GitHub request failed (${response.status}) for ${url}`,
        response.status,
        response.headers.get('retry-after') ?? undefined,
        response.headers.get('x-ratelimit-reset') ?? undefined,
      );
    }
    return response;
  }
}

export interface CollectorResult {
  overlays: number;
  changes: number;
  events: number;
  diagnostics: number;
}

interface CollectionCache {
  runs: Map<string, GitHubWorkflowRun[]>;
  jobs: Map<string, GitHubWorkflowJob[]>;
  manifests: Map<string, LifecycleManifest | undefined>;
  pullRequests: Map<string, GitHubPullRequest[]>;
  pullRequestFiles: Map<string, string[]>;
  commitStatuses: Map<string, GitHubCommitStatus[]>;
  publishedExports: Map<string, PublishedExports | undefined>;
  workspaceSources: Map<string, GitHubWorkspaceSource | undefined>;
}

function newCollectionCache(): CollectionCache {
  return {
    runs: new Map(),
    jobs: new Map(),
    manifests: new Map(),
    pullRequests: new Map(),
    pullRequestFiles: new Map(),
    commitStatuses: new Map(),
    publishedExports: new Map(),
    workspaceSources: new Map(),
  };
}

interface Deferred {
  promise: Promise<boolean>;
  resolve: (success: boolean) => void;
  reject: (error: unknown) => void;
}

interface MatchingJob {
  run: GitHubWorkflowRun;
  job: GitHubWorkflowJob;
}

function pullRequestNumberForChange(
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

function deferred(): Deferred {
  let resolve!: (success: boolean) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<boolean>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function slug(entity: Entity): string | undefined {
  const value = entity.metadata.annotations?.[PROJECT_SLUG];
  return value?.trim() || undefined;
}

function isOverlay(entity: Entity): boolean {
  return (
    entity.kind.toLocaleLowerCase('en-US') === 'component' &&
    entity.spec?.type === 'rhdh-overlay-workspace'
  );
}

function workspace(entity: Entity): string {
  const annotated = entity.metadata.annotations?.[WORKSPACE]?.trim();
  if (annotated) return annotated;

  // PR #4 descriptors predate the explicit workspace annotation. Their
  // generated entity name is canonically `overlay-<workspace>`, so retain
  // compatibility with those live Catalog entities while preferring the
  // annotation for newer descriptors.
  const name = entity.metadata.name;
  return name.startsWith('overlay-') ? name.slice('overlay-'.length) : name;
}

function annotationRefs(entity: Entity, key: string): string[] {
  return (entity.metadata.annotations?.[key] ?? '')
    .split(',')
    .map(ref => ref.trim())
    .filter(Boolean);
}

function catalogEntityRef(entity: Entity): string {
  return `${entity.kind.toLocaleLowerCase('en-US')}:${
    entity.metadata.namespace ?? 'default'
  }/${entity.metadata.name}`;
}

function artifactDigest(reference: unknown): string | undefined {
  if (typeof reference !== 'string') return undefined;
  return reference.match(/@(?<digest>sha256:[a-f0-9]{64})$/)?.groups?.digest;
}

function rateLimitResetAt(error: unknown): string | undefined {
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

function eventId(parts: string[]): string {
  return `github-actions:${createHash('sha256')
    .update(parts.join('|'))
    .digest('hex')}`;
}

function pullRequestExternalStatus(
  pullRequest: GitHubPullRequest,
): 'open' | 'merged' | 'closed' {
  if (pullRequest.merged_at) return 'merged';
  if (pullRequest.state === 'closed' || pullRequest.closed_at) return 'closed';
  return 'open';
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function touchesWorkspace(files: string[], workspaceName: string): boolean {
  const prefix = `workspaces/${workspaceName}/`;
  return files.some(
    file => file === `workspaces/${workspaceName}` || file.startsWith(prefix),
  );
}

/** Run independent GitHub reads in parallel without creating an unbounded burst. */
async function mapWithConcurrency<T, R>(
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

function isImageReference(value: string): boolean {
  // Candidate exports are registry references, optionally prefixed with the
  // OCI transport scheme. Keep validation strict so malformed artifact
  // content cannot become an install instruction in the UI.
  const reference = value.replace(/^oci:\/\//, '');
  return (
    !/\s/.test(value) &&
    /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::\d+)?\/[^\s:@]+(?:[/:][^\s]+)*(?::[^\s]+|@sha256:[a-f0-9]{64})$/.test(
      reference,
    )
  );
}

function latestStatus(
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

function statusPhaseState(status: GitHubCommitStatus | undefined):
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

function commitStatusRun(input: {
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

function conclusion(
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

function runReference(run: GitHubWorkflowRun): LifecycleReference | undefined {
  if (!run.html_url) return undefined;
  return {
    type: 'workflow',
    externalId: String(run.id),
    title: `${run.name ?? 'GitHub Actions'} #${run.run_number}`,
    url: run.html_url,
  };
}

async function recordArtifactEvent(
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

export class GitHubActionsCollector {
  private static readonly DEFAULT_CLOSED_PULL_REQUESTS_PER_WORKSPACE = 3;
  private static readonly MAX_CLOSED_PULL_REQUESTS_PER_REPOSITORY = 100;
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly refreshedAt = new Map<string, number>();
  private readonly rateLimitUntil = new Map<string, number>();
  private readonly repositoryCaches = new Map<
    string,
    { expiresAt: number; cache: CollectionCache }
  >();
  private readonly bootstrapPending = new Map<
    string,
    { overlay: Entity; completion: Deferred }
  >();
  private readonly bootstrapPriority = new Set<string>();
  private bootstrapRunning = false;
  constructor(
    private readonly service: LifecycleService,
    private readonly catalog: CatalogService,
    private readonly auth: AuthService,
    private readonly reader: GitHubActionsReader,
    private readonly logger: LoggerService,
    private readonly workflowFile = 'publish-workspace-plugins.yaml',
    private readonly requireManifest = false,
    private readonly allowedRepository?: string | readonly string[],
    private readonly closedPullRequestsPerWorkspace = GitHubActionsCollector.DEFAULT_CLOSED_PULL_REQUESTS_PER_WORKSPACE,
  ) {}

  async collect(): Promise<CollectorResult> {
    const credentials = await this.auth.getOwnServiceCredentials();
    const response = await this.catalog.queryEntities(
      { filter: [{ kind: 'Component' }], limit: 500 },
      { credentials },
    );
    const configuredRepository = this.allowedRepository;
    let allowedRepositories: readonly string[] | undefined;
    if (typeof configuredRepository === 'string') {
      allowedRepositories = [configuredRepository];
    } else if (configuredRepository) {
      allowedRepositories = configuredRepository;
    }
    const overlays = response.items.filter(entity => {
      const repository = slug(entity);
      if (!isOverlay(entity) || !repository) return false;
      return !allowedRepositories || allowedRepositories.includes(repository);
    });
    const result: CollectorResult = {
      overlays: overlays.length,
      changes: 0,
      events: 0,
      diagnostics: 0,
    };
    const cache = newCollectionCache();
    this.bootstrapRunning = true;
    for (const overlay of overlays) {
      const overlayRef = catalogEntityRef(overlay);
      this.bootstrapPending.set(overlayRef, {
        overlay,
        completion: deferred(),
      });
      await this.updateSyncState(overlayRef, {
        status: 'pending',
        lastAttemptAt: new Date().toISOString(),
      });
    }
    try {
      while (this.bootstrapPending.size > 0) {
        const prioritized = [...this.bootstrapPriority].find(ref =>
          this.bootstrapPending.has(ref),
        );
        const overlayRef =
          prioritized ?? this.bootstrapPending.keys().next().value;
        if (!overlayRef) break;
        this.bootstrapPriority.delete(overlayRef);
        const pending = this.bootstrapPending.get(overlayRef);
        if (!pending) continue;
        try {
          const outcome = await this.collectOverlay(pending.overlay, cache);
          result.changes += outcome.changes;
          result.events += outcome.events;
          pending.completion.resolve(true);
        } catch (error) {
          result.diagnostics += 1;
          await this.updateSyncState(overlayRef, {
            status:
              error instanceof GitHubRequestError &&
              (error.status === 403 || error.status === 429)
                ? 'rate_limited'
                : 'failed',
            lastAttemptAt: new Date().toISOString(),
            errorSummary:
              error instanceof Error ? error.message : String(error),
            rateLimitResetAt: rateLimitResetAt(error),
          });
          // The durable sync state carries the failure; resolve waiters so a
          // prioritized refresh can return the retained cached context.
          pending.completion.resolve(false);
          this.logger.warn(
            `Plugin lifecycle GitHub collection failed for ${pending.overlay.metadata.name}`,
            error as Error,
          );
        } finally {
          this.bootstrapPending.delete(overlayRef);
        }
      }
    } finally {
      this.bootstrapRunning = false;
      for (const pending of this.bootstrapPending.values()) {
        pending.completion.resolve(false);
      }
      this.bootstrapPending.clear();
      this.bootstrapPriority.clear();
    }
    return result;
  }

  async refreshSubject(entityRef: string): Promise<void> {
    const credentials = await this.auth.getOwnServiceCredentials();
    const overlay = await this.findOverlay(entityRef);
    if (!overlay) {
      throw new Error(
        `No lifecycle overlay subject was found for ${entityRef}`,
      );
    }
    await this.service.reconcileSubject(overlay, credentials);
    const overlayRef = catalogEntityRef(overlay);
    const inFlight = this.inFlight.get(overlayRef);
    if (inFlight) {
      await inFlight;
      return;
    }
    const lastRefresh = this.refreshedAt.get(overlayRef);
    if (lastRefresh && Date.now() - lastRefresh < 60_000) return;
    // A subject that is still waiting in the one-time bootstrap queue must
    // not make a user wait behind every other overlay. Remove it from the
    // normal queue and run it immediately with the repository cache. If the
    // queue already started that subject, the two observations may overlap;
    // event IDs and projections keep the result idempotent.
    const queuedForBootstrap =
      this.bootstrapRunning && this.bootstrapPending.has(overlayRef);
    if (queuedForBootstrap) {
      this.bootstrapPending.delete(overlayRef);
      this.bootstrapPriority.delete(overlayRef);
    }
    const work = this.refreshOverlay(overlay, queuedForBootstrap);
    this.inFlight.set(
      overlayRef,
      work.then(() => undefined),
    );
    try {
      const refreshed = await work;
      if (refreshed) this.refreshedAt.set(overlayRef, Date.now());
    } finally {
      this.inFlight.delete(overlayRef);
    }
  }

  private async findOverlay(entityRef: string): Promise<Entity | undefined> {
    const credentials = await this.auth.getOwnServiceCredentials();
    const persistedSubject = await this.service.getSubjectForEntity(entityRef);
    if (persistedSubject) {
      const persistedOverlay = await this.catalog.getEntityByRef(
        persistedSubject.overlayEntityRef,
        { credentials },
      );
      if (persistedOverlay && isOverlay(persistedOverlay)) {
        return persistedOverlay;
      }
    }
    const response = await this.catalog.queryEntities(
      { filter: [{ kind: 'Component' }], limit: 500 },
      { credentials },
    );
    const requested = entityRef.toLocaleLowerCase('en-US');
    for (const overlay of response.items.filter(
      entity => isOverlay(entity) && Boolean(slug(entity)),
    )) {
      if (catalogEntityRef(overlay).toLocaleLowerCase('en-US') === requested) {
        return overlay;
      }
      const associations = await this.service.associationsForEntity(overlay);
      if (
        associations.some(
          association =>
            association.entityRef.toLocaleLowerCase('en-US') === requested,
        )
      ) {
        return overlay;
      }
    }
    return undefined;
  }

  private async refreshOverlay(
    overlay: Entity,
    bypassBootstrapQueue = false,
  ): Promise<boolean> {
    const overlayRef = catalogEntityRef(overlay);
    const rateLimitUntil = this.rateLimitUntil.get(overlayRef);
    if (rateLimitUntil && rateLimitUntil > Date.now()) {
      await this.updateSyncState(overlayRef, {
        status: 'rate_limited',
        lastAttemptAt: new Date().toISOString(),
        rateLimitResetAt: new Date(rateLimitUntil).toISOString(),
      });
      return false;
    }
    if (rateLimitUntil) this.rateLimitUntil.delete(overlayRef);
    await this.updateSyncState(overlayRef, {
      status: 'prioritized',
      lastAttemptAt: new Date().toISOString(),
    });
    const pending = this.bootstrapPending.get(overlayRef);
    if (this.bootstrapRunning && pending && !bypassBootstrapQueue) {
      this.bootstrapPriority.add(overlayRef);
      return pending.completion.promise;
    }
    try {
      const repository = slug(overlay)!;
      const existingCache = this.repositoryCaches.get(repository);
      const cache =
        existingCache && existingCache.expiresAt > Date.now()
          ? existingCache.cache
          : newCollectionCache();
      this.repositoryCaches.set(repository, {
        cache,
        expiresAt: Date.now() + 60_000,
      });
      await this.collectOverlay(overlay, cache);
      return true;
    } catch (error) {
      const repository = slug(overlay);
      if (repository) this.repositoryCaches.delete(repository);
      const resetAt = rateLimitResetAt(error);
      if (resetAt) this.rateLimitUntil.set(overlayRef, Date.parse(resetAt));
      await this.updateSyncState(overlayRef, {
        status:
          error instanceof GitHubRequestError &&
          (error.status === 403 || error.status === 429)
            ? 'rate_limited'
            : 'failed',
        lastAttemptAt: new Date().toISOString(),
        errorSummary: error instanceof Error ? error.message : String(error),
        rateLimitResetAt: rateLimitResetAt(error),
      });
      this.logger.warn(
        `Plugin lifecycle GitHub refresh failed for ${overlay.metadata.name}`,
        error as Error,
      );
      throw error;
    }
  }

  private async collectPullRequests(
    overlay: Entity,
    cache: CollectionCache,
  ): Promise<{ changes: number; events: number }> {
    if (
      (!this.reader.listOpenPullRequests &&
        !this.reader.listClosedPullRequests) ||
      !this.reader.listPullRequestFiles ||
      !this.reader.getCommitStatuses
    ) {
      return { changes: 0, events: 0 };
    }
    const repository = slug(overlay);
    if (!repository) return { changes: 0, events: 0 };
    const workspaceName = workspace(overlay);
    const closedPullRequestQuota = Math.max(
      0,
      Math.min(100, Math.floor(this.closedPullRequestsPerWorkspace)),
    );
    const openPullRequestsKey = `${repository}:open`;
    let openPullRequests = cache.pullRequests.get(openPullRequestsKey);
    if (!openPullRequests) {
      openPullRequests = this.reader.listOpenPullRequests
        ? await this.reader.listOpenPullRequests(repository)
        : [];
      cache.pullRequests.set(openPullRequestsKey, openPullRequests);
    }
    const closedPullRequestsKey = `${repository}:closed`;
    let closedPullRequests: GitHubPullRequest[] = [];
    if (closedPullRequestQuota > 0) {
      closedPullRequests = cache.pullRequests.get(closedPullRequestsKey) ?? [];
      if (!cache.pullRequests.has(closedPullRequestsKey)) {
        closedPullRequests = this.reader.listClosedPullRequests
          ? await this.reader.listClosedPullRequests(repository)
          : [];
        cache.pullRequests.set(
          closedPullRequestsKey,
          closedPullRequests
            .slice()
            .sort(
              (left, right) =>
                (Date.parse(right.updated_at ?? '') || 0) -
                (Date.parse(left.updated_at ?? '') || 0),
            )
            .slice(
              0,
              GitHubActionsCollector.MAX_CLOSED_PULL_REQUESTS_PER_REPOSITORY,
            ),
        );
        closedPullRequests =
          cache.pullRequests.get(closedPullRequestsKey) ?? [];
      }
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
            let files = cache.pullRequestFiles.get(filesKey);
            if (!files) {
              files = await this.reader.listPullRequestFiles!(
                repository,
                pullRequest.number,
              );
              cache.pullRequestFiles.set(filesKey, files);
            }
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
      closedPullRequests.length >=
        GitHubActionsCollector.MAX_CLOSED_PULL_REQUESTS_PER_REPOSITORY &&
      matchingClosedPullRequests.length < closedPullRequestQuota
    ) {
      await this.service.recordSystemDiagnostic({
        source: 'github-actions',
        subjectEntityRef: catalogEntityRef(overlay),
        externalId: `${repository}:${workspaceName}:closed-pr-cap`,
        reasonCode: 'closed-pr-history-cap',
        summary: `Closed PR history scan reached the repository cap before finding ${closedPullRequestQuota} PRs for workspace ${workspaceName}`,
        details: {
          repository,
          workspace: workspaceName,
          repositoryCap:
            GitHubActionsCollector.MAX_CLOSED_PULL_REQUESTS_PER_REPOSITORY,
          matchingClosedPullRequests: matchingClosedPullRequests.length,
        },
      });
    }
    const associations = await this.service.associationsForEntity(overlay);
    let changes = 0;
    let events = 0;
    const lifecycleService = this.service as LifecycleService & {
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
        if (
          pullRequestNumber &&
          !openPullRequestNumbers.has(pullRequestNumber)
        ) {
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
      let statuses = cache.commitStatuses.get(statusKey);
      if (!statuses) {
        statuses = await this.reader.getCommitStatuses(repository, headSha);
        cache.commitStatuses.set(statusKey, statuses);
      }
      const publish = latestStatus(statuses, 'publish');
      const smoke = latestStatus(statuses, 'smoketest');
      const sourceKey = `${repository}:${workspaceName}:${headSha}`;
      let source = cache.workspaceSources.get(sourceKey);
      if (
        !cache.workspaceSources.has(sourceKey) &&
        this.reader.getWorkspaceSource
      ) {
        try {
          source = await this.reader.getWorkspaceSource(
            repository,
            workspaceName,
            headSha,
          );
        } catch (error) {
          await this.service.recordSystemDiagnostic({
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
      const change = await this.service.createSystemChange(
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
      await this.service.recordSystemEvent({
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
      await this.service.recordSystemEvent({
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
        await this.service.recordSystemEvent({
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
        await this.service.recordSystemEvent({
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
        await this.service.recordSystemEvent({
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
      if (publish?.state === 'success' && this.reader.getPublishedExports) {
        const artifactKey = `${repository}:${pullRequest.number}`;
        let published = cache.publishedExports.get(artifactKey);
        if (!cache.publishedExports.has(artifactKey)) {
          try {
            published = await this.reader.getPublishedExports(
              repository,
              pullRequest.number,
            );
          } catch (error) {
            await this.service.recordSystemDiagnostic({
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
          await this.service.recordSystemDiagnostic({
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
          await this.service.recordSystemDiagnostic({
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
          await this.service.recordSystemEvent({
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

  private async collectOverlay(
    overlay: Entity,
    cache: CollectionCache,
  ): Promise<{ changes: number; events: number }> {
    const overlayRef = catalogEntityRef(overlay);
    await this.updateSyncState(overlayRef, {
      status: 'running',
      lastAttemptAt: new Date().toISOString(),
    });
    const repository = slug(overlay)!;
    // PR evidence is the most useful result of an on-demand refresh and is
    // independent of the mainline workflow scan. Collect it first so open and
    // closed changes are persisted even when the larger job scan exceeds the
    // HTTP wait budget.
    const pullRequestResult = await this.collectPullRequests(overlay, cache);
    const runsKey = `${repository}:${this.workflowFile}`;
    let runs = cache.runs.get(runsKey);
    if (!runs) {
      runs = await this.reader.listRuns(repository, this.workflowFile);
      cache.runs.set(runsKey, runs);
    }
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
        let jobs = cache.jobs.get(jobsKey);
        if (!jobs) {
          jobs = await this.reader.listJobs(repository, run.id, runAttempt);
          cache.jobs.set(jobsKey, jobs);
        }
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
      await this.service.recordSystemDiagnostic({
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
      await this.updateSyncState(overlayRef, {
        status: 'empty',
        lastAttemptAt: new Date().toISOString(),
        lastSuccessAt: new Date().toISOString(),
      });
      await this.updateSyncState(overlayRef, {
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
    const associations = await this.service.associationsForEntity(overlay);
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
      const change = await this.service.createSystemChange(
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
          await this.service.recordSystemEvent({
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
        await this.service.recordSystemEvent({
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
        await this.service.recordSystemEvent({
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
        if (this.requireManifest) {
          const manifestKey = `${repository}:${winning.run.id}:${runAttempt}`;
          let manifest = cache.manifests.get(manifestKey);
          if (!cache.manifests.has(manifestKey)) {
            try {
              manifest = this.reader.getLifecycleManifest
                ? await this.reader.getLifecycleManifest(
                    repository,
                    winning.run.id,
                    runAttempt,
                  )
                : undefined;
            } catch (error) {
              await this.service.recordSystemDiagnostic({
                source: 'github-actions',
                subjectEntityRef: overlayRef,
                externalId: `${winning.run.id}:${runAttempt}`,
                reasonCode: 'publication-manifest-invalid',
                summary:
                  error instanceof Error
                    ? error.message
                    : 'Lifecycle manifest could not be validated',
                details: { repository, workflow: this.workflowFile },
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
                await this.service.recordSystemDiagnostic({
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
                await this.service.recordSystemDiagnostic({
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
                this.service,
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
            await this.service.recordSystemDiagnostic({
              source: 'github-actions',
              subjectEntityRef: overlayRef,
              externalId: `${winning.run.id}:${runAttempt}`,
              reasonCode: 'publication-manifest-unavailable',
              summary:
                'Workflow succeeded, but publication remains pending until its lifecycle manifest is ingested',
              details: {
                repository,
                workflow: this.workflowFile,
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
          this.requireManifest &&
          packageRefs.length > 0 &&
          validPackageCount === packageRefs.length
        ) {
          if (winningRunPayload && winningSnapshotEventId) {
            await this.service.recordSystemEvent({
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
          await this.service.recordSystemEvent({
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
        } else if (this.requireManifest && packageRefs.length > 0) {
          await this.service.recordSystemEvent({
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
    await this.updateSyncState(overlayRef, {
      status: 'succeeded',
      lastAttemptAt: new Date().toISOString(),
      lastSuccessAt: new Date().toISOString(),
    });
    return {
      changes: groups.size + pullRequestResult.changes,
      events: totalEvents + pullRequestResult.events,
    };
  }

  private async updateSyncState(
    entityRef: string,
    state: Parameters<LifecycleService['updateSyncState']>[1],
  ): Promise<void> {
    const service = this.service as LifecycleService & {
      updateSyncState?: LifecycleService['updateSyncState'];
    };
    if (service.updateSyncState)
      await service.updateSyncState(entityRef, state);
  }
}
