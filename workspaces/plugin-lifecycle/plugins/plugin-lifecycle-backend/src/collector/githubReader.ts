/*
 * Copyright Red Hat, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 */
import type { GithubCredentialsProvider } from '@backstage/integration';
import {
  parseLifecycleManifestArchive,
  parsePublishedExportsArchive,
  type LifecycleManifest,
  type PublishedExports,
} from './artifactValidation';
import { GitHubRequestClient } from './githubClient';

export { GitHubRequestError, isGitHubRateLimited } from './githubClient';
export type { LifecycleManifest, PublishedExports } from './artifactValidation';

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

export interface GitHubWorkspaceSource {
  repository: string;
  revision: string;
}

export interface GitHubActionsReader {
  listRuns(
    repository: string,
    workflowFile?: string,
    maxRuns?: number,
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

/** Read-only GitHub API adapter used by the collector. */
export class GitHubRestActionsReader implements GitHubActionsReader {
  private readonly client: GitHubRequestClient;

  constructor(
    credentials: string | GithubCredentialsProvider,
    apiBase = 'https://api.github.com',
    requestTimeoutMs = 20_000,
  ) {
    this.client = new GitHubRequestClient(
      credentials,
      apiBase,
      requestTimeoutMs,
    );
  }

  async listRuns(
    repository: string,
    workflowFile?: string,
    maxRuns = 100,
  ): Promise<GitHubWorkflowRun[]> {
    const suffix = workflowFile
      ? `/actions/workflows/${encodeURIComponent(workflowFile)}/runs`
      : '/actions/runs';
    const boundedMaxRuns = Number.isFinite(maxRuns)
      ? Math.max(1, Math.min(100, Math.floor(maxRuns)))
      : 100;
    const runs: GitHubWorkflowRun[] = [];
    for (let page = 1; page <= 10 && runs.length < boundedMaxRuns; page += 1) {
      const response = await this.client.get(
        this.client.url(
          `/repos/${repository}${suffix}?per_page=${boundedMaxRuns}&page=${page}`,
        ),
        repository,
      );
      const body = (await response.json()) as {
        workflow_runs?: GitHubWorkflowRun[];
      };
      const pageRuns = body.workflow_runs ?? [];
      runs.push(...pageRuns);
      if (pageRuns.length < boundedMaxRuns) break;
    }
    return runs.slice(0, boundedMaxRuns);
  }

  async listJobs(
    repository: string,
    runId: number,
    runAttempt = 1,
  ): Promise<GitHubWorkflowJob[]> {
    const jobs: GitHubWorkflowJob[] = [];
    for (let page = 1; page <= 10; page += 1) {
      const attemptPath = runAttempt > 1 ? `/attempts/${runAttempt}` : '';
      const response = await this.client.get(
        this.client.url(
          `/repos/${repository}/actions/runs/${runId}${attemptPath}/jobs?per_page=100&page=${page}`,
        ),
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
      const response = await this.client.get(
        this.client.url(
          `/repos/${repository}/pulls?state=${state}&sort=updated&direction=desc&per_page=100&page=${page}`,
        ),
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
      const response = await this.client.get(
        this.client.url(
          `/repos/${repository}/pulls/${pullRequestNumber}/files?per_page=100&page=${page}`,
        ),
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
      const response = await this.client.get(
        this.client.url(
          `/repos/${repository}/commits/${commitSha}/status?per_page=100&page=${page}`,
        ),
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
      const response = await this.client.get(
        this.client.url(
          `/repos/${repository}/actions/artifacts?per_page=100&page=${page}&name=published-exports-pr-${pullRequestNumber}`,
        ),
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
        candidate.name === `published-exports-pr-${pullRequestNumber}` &&
        !candidate.expired &&
        Boolean(candidate.archive_download_url),
    );
    if (!artifact?.archive_download_url) return undefined;
    if ((artifact.size_in_bytes ?? 0) > 1_048_576) {
      throw new Error('Published exports artifact exceeds the 1 MiB limit');
    }
    const archiveResponse = await this.client.get(
      artifact.archive_download_url,
      repository,
    );
    return parsePublishedExportsArchive(
      new Uint8Array(await archiveResponse.arrayBuffer()),
      repository,
      pullRequestNumber,
      artifact.digest,
    );
  }

  async getWorkspaceSource(
    repository: string,
    workspaceName: string,
    ref: string,
  ): Promise<GitHubWorkspaceSource | undefined> {
    const response = await this.client.get(
      this.client.url(
        `/repos/${repository}/contents/workspaces/${encodeURIComponent(
          workspaceName,
        )}/source.json?ref=${encodeURIComponent(ref)}`,
      ),
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
    ) {
      return undefined;
    }
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
      const response = await this.client.get(
        this.client.url(
          `/repos/${repository}/actions/runs/${runId}/artifacts?per_page=100&page=${page}`,
        ),
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
        candidate.name === 'plugin-lifecycle-manifest.json' &&
        !candidate.expired &&
        Boolean(candidate.archive_download_url),
    );
    if (!artifact?.archive_download_url) return undefined;
    const response = await this.client.get(
      artifact.archive_download_url,
      repository,
    );
    return parseLifecycleManifestArchive(
      new Uint8Array(await response.arrayBuffer()),
      repository,
      runId,
      runAttempt,
      artifact.digest,
    );
  }
}
