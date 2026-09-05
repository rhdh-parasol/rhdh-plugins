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
import { mockCredentials } from '@backstage/backend-test-utils';
import type { Entity } from '@backstage/catalog-model';
import type { CatalogService } from '@backstage/plugin-catalog-node';
import type { AuthService, LoggerService } from '@backstage/backend-plugin-api';
import {
  GitHubActionsCollector,
  GitHubRequestError,
  GitHubRestActionsReader,
  isGitHubRateLimited,
  type LifecycleManifest,
  type GitHubActionsReader,
  type GitHubWorkflowRun,
} from './GitHubActionsCollector';
import type { LifecycleService } from '../service/LifecycleService';
import { slug } from './collectorHelpers';

const overlay: Entity = {
  apiVersion: 'backstage.io/v1alpha1',
  kind: 'Component',
  metadata: {
    name: 'overlay-demo',
    namespace: 'default',
    annotations: {
      'github.com/project-slug': 'rhdh-parasol/rhdh-plugin-export-overlays',
      'rhdh.io/overlay-workspace': 'global-header',
      'rhdh.io/source-commit-sha': 'aabb85ef001ddae5af621ecf17e02f7bac9175e3',
      'rhdh.io/extensions-package-refs': 'package:rhdh/global-header',
    },
  },
  spec: { type: 'rhdh-overlay-workspace' },
};
const generatedOverlayWithoutWorkspaceAnnotation: Entity = {
  ...overlay,
  metadata: {
    ...overlay.metadata,
    name: 'overlay-global-header',
    annotations: {
      'github.com/project-slug':
        overlay.metadata.annotations?.['github.com/project-slug'] ?? '',
      'rhdh.io/source-commit-sha':
        overlay.metadata.annotations?.['rhdh.io/source-commit-sha'] ?? '',
      'rhdh.io/extensions-package-refs':
        overlay.metadata.annotations?.['rhdh.io/extensions-package-refs'] ?? '',
    },
  },
};
const packageEntity: Entity = {
  apiVersion: 'extensions.backstage.io/v1alpha1',
  kind: 'Package',
  metadata: { name: 'global-header', namespace: 'rhdh' },
  spec: {
    packageName: '@rhdh/global-header',
    version: '2.0.0',
    dynamicArtifact:
      'oci://ghcr.io/rhdh/global-header:2.0.0@sha256:58bf836bfcfb73e6866d3288db974218c059b226f6d4a8c6d776ac3b7df2f332',
  },
};

describe('GitHubActionsCollector', () => {
  it('rejects malformed repository annotations before building GitHub URLs', () => {
    expect(
      slug({
        ...overlay,
        metadata: {
          ...overlay.metadata,
          annotations: {
            ...overlay.metadata.annotations,
            'github.com/project-slug': 'trusted/repo?path=/actions/runs',
          },
        },
      }),
    ).toBeUndefined();
  });

  it('distinguishes GitHub permission failures from rate limiting', () => {
    expect(isGitHubRateLimited(new GitHubRequestError('forbidden', 403))).toBe(
      false,
    );
    expect(
      isGitHubRateLimited(
        new GitHubRequestError(
          'rate limited',
          403,
          undefined,
          '2000000000',
          '0',
        ),
      ),
    ).toBe(true);
    expect(
      isGitHubRateLimited(new GitHubRequestError('rate limited', 429)),
    ).toBe(true);
  });

  it('uses the GitHub Actions workflow-runs endpoint when a workflow file is configured', async () => {
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ workflow_runs: [] }),
      headers: new Headers(),
    } as Response);

    try {
      await new GitHubRestActionsReader('test-token').listRuns(
        'rhdh-parasol/rhdh-plugin-export-overlays',
        'publish-workspace-plugins.yaml',
      );

      expect(fetchMock).toHaveBeenCalledWith(
        'https://api.github.com/repos/rhdh-parasol/rhdh-plugin-export-overlays/actions/workflows/publish-workspace-plugins.yaml/runs?per_page=100&page=1',
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer test-token',
          }),
          signal: expect.any(AbortSignal),
        }),
      );
    } finally {
      fetchMock.mockRestore();
    }
  });

  it('aborts a hung GitHub request and reports a bounded timeout', async () => {
    jest.useFakeTimers();
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockImplementation(
      async (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          );
        }),
    );
    try {
      const request = new GitHubRestActionsReader(
        'test-token',
        'https://api.github.com',
        1_000,
      ).listRuns('example/overlays', 'publish.yaml');
      jest.advanceTimersByTime(1_000);
      await expect(request).rejects.toThrow('timed out');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      fetchMock.mockRestore();
      jest.useRealTimers();
    }
  });

  it('queries closed pull requests through the bounded recent-history endpoint', async () => {
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => [
        {
          number: 42,
          state: 'closed',
          merged_at: '2026-09-02T10:00:00.000Z',
        },
      ],
      headers: new Headers(),
    } as unknown as Response);

    try {
      await expect(
        new GitHubRestActionsReader('test-token').listClosedPullRequests(
          'redhat-developer/rhdh-plugin-export-overlays',
        ),
      ).resolves.toEqual([
        {
          number: 42,
          state: 'closed',
          merged_at: '2026-09-02T10:00:00.000Z',
        },
      ]);

      expect(fetchMock).toHaveBeenCalledWith(
        'https://api.github.com/repos/redhat-developer/rhdh-plugin-export-overlays/pulls?state=closed&sort=updated&direction=desc&per_page=100&page=1',
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer test-token',
          }),
        }),
      );
    } finally {
      fetchMock.mockRestore();
    }
  });

  it('reads the source repository and revision from the PR head source.json', async () => {
    const source = Buffer.from(
      JSON.stringify({
        repo: 'https://github.com/rhdh-parasol/rhdh-plugins',
        'repo-ref': 'be7777a9a9c1e5b52d845eec1bc489df7f5582fd',
      }),
    ).toString('base64');
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ content: source, encoding: 'base64' }),
      headers: new Headers(),
    } as Response);

    try {
      await expect(
        new GitHubRestActionsReader('test-token').getWorkspaceSource(
          'rhdh-parasol/rhdh-plugin-export-overlays',
          'adoption-insights',
          'pr-head-sha',
        ),
      ).resolves.toEqual({
        repository: 'rhdh-parasol/rhdh-plugins',
        revision: 'be7777a9a9c1e5b52d845eec1bc489df7f5582fd',
      });
      expect(fetchMock).toHaveBeenCalledWith(
        'https://api.github.com/repos/rhdh-parasol/rhdh-plugin-export-overlays/contents/workspaces/adoption-insights/source.json?ref=pr-head-sha',
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer test-token',
          }),
        }),
      );
    } finally {
      fetchMock.mockRestore();
    }
  });

  it('treats a missing source.json as optional workspace metadata', async () => {
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 404,
      headers: new Headers(),
    } as unknown as Response);

    try {
      await expect(
        new GitHubRestActionsReader('test-token').getWorkspaceSource(
          'rhdh-parasol/rhdh-plugin-export-overlays',
          'workspace-without-source',
          'main',
        ),
      ).resolves.toBeUndefined();
    } finally {
      fetchMock.mockRestore();
    }
  });

  it('records workspace jobs without treating Catalog metadata as run evidence', async () => {
    const service = {
      createSystemChange: jest.fn().mockResolvedValue({
        change: { changeId: '18163e4e-b0a5-431b-80f1-4913362d9926' },
      }),
      associationsForEntity: jest.fn().mockResolvedValue([]),
      recordSystemEvent: jest.fn().mockResolvedValue(undefined),
      recordSystemDiagnostic: jest.fn().mockResolvedValue(undefined),
    } as unknown as LifecycleService;
    const catalog = {
      queryEntities: jest.fn().mockResolvedValue({ items: [overlay] }),
      getEntityByRef: jest.fn().mockResolvedValue(packageEntity),
    } as unknown as jest.Mocked<CatalogService>;
    const reader: GitHubActionsReader = {
      listRuns: jest.fn().mockResolvedValue([
        {
          id: 42,
          run_number: 7,
          run_attempt: 1,
          name: 'Publish',
          status: 'completed',
          conclusion: 'success',
          head_sha: 'aabb85ef001ddae5af621ecf17e02f7bac9175e3',
          updated_at: '2026-09-01T10:00:00.000Z',
        },
      ]),
      listJobs: jest.fn().mockResolvedValue([
        {
          id: 99,
          name: 'export / workspaces/global-header',
          status: 'completed',
          conclusion: 'success',
          html_url:
            'https://github.com/rhdh-parasol/rhdh-plugin-export-overlays/actions/runs/42/jobs/99',
        },
      ]),
    };
    const auth = {
      getOwnServiceCredentials: jest
        .fn()
        .mockResolvedValue(mockCredentials.service('collector')),
    } as unknown as AuthService;
    const logger = { warn: jest.fn() } as unknown as LoggerService;
    const result = await new GitHubActionsCollector(
      service,
      catalog,
      auth,
      reader,
      logger,
      'publish-workspace-plugins.yaml',
      false,
    ).collect();
    expect(result).toEqual({
      overlays: 1,
      changes: 1,
      events: 2,
      diagnostics: 0,
    });
    expect(service.recordSystemEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({
        event: expect.objectContaining({ kind: 'artifact.recorded' }),
      }),
    );
    expect(reader.listJobs).toHaveBeenCalledWith(
      'rhdh-parasol/rhdh-plugin-export-overlays',
      42,
      1,
    );
    expect(service.createSystemChange).toHaveBeenCalledWith(
      expect.objectContaining({ initialReferences: [] }),
      expect.anything(),
    );
    expect(service.recordSystemDiagnostic).not.toHaveBeenCalled();
  });

  it('derives the workspace from PR #4 overlay names when the annotation is absent', async () => {
    const service = {
      createSystemChange: jest.fn().mockResolvedValue({
        change: { changeId: '18163e4e-b0a5-431b-80f1-4913362d9926' },
      }),
      associationsForEntity: jest.fn().mockResolvedValue([]),
      recordSystemEvent: jest.fn().mockResolvedValue(undefined),
      recordSystemDiagnostic: jest.fn().mockResolvedValue(undefined),
    } as unknown as LifecycleService;
    const catalog = {
      queryEntities: jest.fn().mockResolvedValue({
        items: [generatedOverlayWithoutWorkspaceAnnotation],
      }),
      getEntityByRef: jest.fn().mockResolvedValue(packageEntity),
    } as unknown as jest.Mocked<CatalogService>;
    const reader: GitHubActionsReader = {
      listRuns: jest.fn().mockResolvedValue([
        {
          id: 42,
          run_number: 7,
          run_attempt: 1,
          name: 'Publish',
          status: 'completed',
          conclusion: 'success',
          head_sha: 'aabb85ef001ddae5af621ecf17e02f7bac9175e3',
          updated_at: '2026-09-01T10:00:00.000Z',
        },
      ]),
      listJobs: jest.fn().mockResolvedValue([
        {
          id: 99,
          name: 'export / workspaces/global-header',
          status: 'completed',
          conclusion: 'success',
        },
      ]),
    };
    const auth = {
      getOwnServiceCredentials: jest
        .fn()
        .mockResolvedValue(mockCredentials.service('collector')),
    } as unknown as AuthService;

    const result = await new GitHubActionsCollector(
      service,
      catalog,
      auth,
      reader,
      { warn: jest.fn() } as unknown as LoggerService,
      'publish-workspace-plugins.yaml',
      false,
    ).collect();

    expect(result.changes).toBe(1);
    expect(service.recordSystemDiagnostic).not.toHaveBeenCalled();
  });

  it('loads jobs separately for repeated workflow attempts', async () => {
    const service = {
      createSystemChange: jest.fn().mockResolvedValue({
        change: { changeId: '18163e4e-b0a5-431b-80f1-4913362d9926' },
      }),
      associationsForEntity: jest.fn().mockResolvedValue([]),
      recordSystemEvent: jest.fn().mockResolvedValue(undefined),
      recordSystemDiagnostic: jest.fn().mockResolvedValue(undefined),
    } as unknown as LifecycleService;
    const catalog = {
      queryEntities: jest.fn().mockResolvedValue({ items: [overlay] }),
      getEntityByRef: jest.fn().mockResolvedValue(packageEntity),
    } as unknown as jest.Mocked<CatalogService>;
    const reader: GitHubActionsReader = {
      listRuns: jest.fn().mockResolvedValue([
        {
          id: 44,
          run_number: 9,
          run_attempt: 1,
          name: 'Publish',
          status: 'completed',
          conclusion: 'failure',
          head_sha: 'aabb85ef001ddae5af621ecf17e02f7bac9175e3',
          updated_at: '2026-09-01T12:00:00.000Z',
        },
        {
          id: 44,
          run_number: 9,
          run_attempt: 2,
          name: 'Publish',
          status: 'completed',
          conclusion: 'success',
          head_sha: 'aabb85ef001ddae5af621ecf17e02f7bac9175e3',
          updated_at: '2026-09-01T12:05:00.000Z',
        },
      ]),
      listJobs: jest.fn(async (_repository, _runId, attempt = 1) => [
        {
          id: 100 + attempt,
          name: 'export / workspaces/global-header',
          status: 'completed' as const,
          conclusion:
            attempt === 2 ? ('success' as const) : ('failure' as const),
        },
      ]),
    };
    const auth = {
      getOwnServiceCredentials: jest
        .fn()
        .mockResolvedValue(mockCredentials.service('collector')),
    } as unknown as AuthService;
    const logger = { warn: jest.fn() } as unknown as LoggerService;

    const result = await new GitHubActionsCollector(
      service,
      catalog,
      auth,
      reader,
      logger,
      'publish-workspace-plugins.yaml',
      false,
    ).collect();

    expect(result.changes).toBe(1);
    expect(reader.listJobs).toHaveBeenNthCalledWith(
      1,
      'rhdh-parasol/rhdh-plugin-export-overlays',
      44,
      1,
    );
    expect(reader.listJobs).toHaveBeenNthCalledWith(
      2,
      'rhdh-parasol/rhdh-plugin-export-overlays',
      44,
      2,
    );
  });

  it('does not claim publication from catalog metadata without a manifest', async () => {
    const service = {
      createSystemChange: jest.fn().mockResolvedValue({
        change: { changeId: '18163e4e-b0a5-431b-80f1-4913362d9926' },
      }),
      associationsForEntity: jest.fn().mockResolvedValue([]),
      recordSystemEvent: jest.fn().mockResolvedValue(undefined),
      recordSystemDiagnostic: jest.fn().mockResolvedValue(undefined),
    } as unknown as LifecycleService;
    const catalog = {
      queryEntities: jest.fn().mockResolvedValue({ items: [overlay] }),
      getEntityByRef: jest.fn().mockResolvedValue(packageEntity),
    } as unknown as jest.Mocked<CatalogService>;
    const reader: GitHubActionsReader = {
      listRuns: jest.fn().mockResolvedValue([
        {
          id: 43,
          run_number: 8,
          run_attempt: 1,
          name: 'Publish',
          status: 'completed',
          conclusion: 'success',
          head_sha: 'aabb85ef001ddae5af621ecf17e02f7bac9175e3',
          updated_at: '2026-09-01T11:00:00.000Z',
        },
      ]),
      listJobs: jest.fn().mockResolvedValue([
        {
          id: 100,
          name: 'export / workspaces/global-header',
          status: 'completed',
          conclusion: 'success',
        },
      ]),
    };
    const auth = {
      getOwnServiceCredentials: jest
        .fn()
        .mockResolvedValue(mockCredentials.service('collector')),
    } as unknown as AuthService;

    const result = await new GitHubActionsCollector(
      service,
      catalog,
      auth,
      reader,
      { warn: jest.fn() } as unknown as LoggerService,
      'publish-workspace-plugins.yaml',
      true,
    ).collect();

    expect(result.events).toBe(3);
    expect(service.recordSystemDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({
        reasonCode: 'publication-manifest-unavailable',
      }),
    );
    expect(service.recordSystemEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({
        event: expect.objectContaining({ kind: 'artifact.recorded' }),
      }),
    );
  });

  it('uses a matching lifecycle manifest as publication evidence', async () => {
    const service = {
      createSystemChange: jest.fn().mockResolvedValue({
        change: { changeId: '18163e4e-b0a5-431b-80f1-4913362d9926' },
      }),
      associationsForEntity: jest.fn().mockResolvedValue([]),
      recordSystemEvent: jest.fn().mockResolvedValue(undefined),
      recordSystemDiagnostic: jest.fn().mockResolvedValue(undefined),
    } as unknown as LifecycleService;
    const catalog = {
      queryEntities: jest.fn().mockResolvedValue({ items: [overlay] }),
    } as unknown as jest.Mocked<CatalogService>;
    const manifest: LifecycleManifest = {
      schemaVersion: '1',
      repository: 'rhdh-parasol/rhdh-plugin-export-overlays',
      workflow: 'publish-workspace-plugins.yaml',
      runId: '42',
      runNumber: 7,
      runAttempt: 1,
      event: 'push',
      ref: 'refs/heads/main',
      headSha: 'aabb85ef001ddae5af621ecf17e02f7bac9175e3',
      runUrl: 'https://github.com/example/run/42',
      packages: [
        {
          workspace: 'global-header',
          packageEntityRef: 'package:rhdh/global-header',
          packageName: '@rhdh/global-header',
          version: '2.0.0',
          ociReference:
            'oci://ghcr.io/rhdh/global-header:2.0.0@sha256:58bf836bfcfb73e6866d3288db974218c059b226f6d4a8c6d776ac3b7df2f332',
          ociDigest:
            'sha256:58bf836bfcfb73e6866d3288db974218c059b226f6d4a8c6d776ac3b7df2f332',
        },
      ],
    };
    const reader: GitHubActionsReader = {
      listRuns: jest.fn().mockResolvedValue([
        {
          id: 42,
          run_number: 7,
          run_attempt: 1,
          name: 'Publish',
          status: 'completed',
          conclusion: 'success',
          head_sha: 'aabb85ef001ddae5af621ecf17e02f7bac9175e3',
          updated_at: '2026-09-01T10:00:00.000Z',
        },
      ]),
      listJobs: jest.fn().mockResolvedValue([
        {
          id: 99,
          name: 'export / workspaces/global-header',
          status: 'completed',
          conclusion: 'success',
        },
      ]),
      getLifecycleManifest: jest.fn().mockResolvedValue(manifest),
    };
    const auth = {
      getOwnServiceCredentials: jest
        .fn()
        .mockResolvedValue(mockCredentials.service('collector')),
    } as unknown as AuthService;

    const result = await new GitHubActionsCollector(
      service,
      catalog,
      auth,
      reader,
      { warn: jest.fn() } as unknown as LoggerService,
      'publish-workspace-plugins.yaml',
      true,
    ).collect();

    expect(result.events).toBe(5);
    expect(service.recordSystemEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: expect.objectContaining({ kind: 'artifact.recorded' }),
      }),
    );
    expect(service.recordSystemDiagnostic).not.toHaveBeenCalled();
  });

  it('collects exact workspace PR checks and candidate images from the existing artifact', async () => {
    const service = {
      createSystemChange: jest.fn().mockResolvedValue({
        change: { changeId: '18163e4e-b0a5-431b-80f1-4913362d9926' },
      }),
      associationsForEntity: jest.fn().mockResolvedValue([]),
      recordSystemEvent: jest.fn().mockResolvedValue(undefined),
      recordSystemDiagnostic: jest.fn().mockResolvedValue(undefined),
    } as unknown as LifecycleService;
    const catalog = {
      queryEntities: jest.fn().mockResolvedValue({ items: [overlay] }),
    } as unknown as jest.Mocked<CatalogService>;
    const reader: GitHubActionsReader = {
      listRuns: jest.fn().mockResolvedValue([]),
      listJobs: jest.fn(),
      listOpenPullRequests: jest.fn().mockResolvedValue([
        {
          number: 3099,
          title: 'Fix Global Header export',
          html_url:
            'https://github.com/rhdh-parasol/rhdh-plugin-export-overlays/pull/3099',
          user: { login: 'plugin-author' },
          head: { sha: 'aabb85ef001ddae5af621ecf17e02f7bac9175e3' },
          created_at: '2026-09-03T09:00:00.000Z',
          updated_at: '2026-09-03T10:00:00.000Z',
        },
        {
          number: 4000,
          title: 'Unrelated workspace',
          head: { sha: 'cccccccccccccccccccccccccccccccccccccccc' },
        },
      ]),
      listPullRequestFiles: jest
        .fn()
        .mockResolvedValueOnce(['workspaces/global-header/source.json'])
        .mockResolvedValueOnce(['workspaces/adoption-insights/source.json']),
      getCommitStatuses: jest.fn().mockResolvedValue([
        {
          context: 'publish',
          state: 'success',
          description: 'Published candidate images',
          target_url:
            'https://github.com/rhdh-parasol/rhdh-plugin-export-overlays/actions/runs/3099',
          updated_at: '2026-09-03T10:01:00.000Z',
        },
        {
          context: 'smoketest',
          state: 'pending',
          description: 'Waiting for smoke tests',
          target_url:
            'https://github.com/rhdh-parasol/rhdh-plugin-export-overlays/actions/runs/3099',
          updated_at: '2026-09-03T10:02:00.000Z',
        },
      ]),
      getPublishedExports: jest.fn().mockResolvedValue({
        repository: 'rhdh-parasol/rhdh-plugin-export-overlays',
        workspace: 'global-header',
        overlayCommit: 'aabb85ef001ddae5af621ecf17e02f7bac9175e3',
        pullRequestNumber: 3099,
        images: ['quay.io/rhdh/global-header:pr_3099__2.0.0'],
      }),
    };
    const auth = {
      getOwnServiceCredentials: jest
        .fn()
        .mockResolvedValue(mockCredentials.service('collector')),
    } as unknown as AuthService;

    const result = await new GitHubActionsCollector(
      service,
      catalog,
      auth,
      reader,
      { warn: jest.fn() } as unknown as LoggerService,
    ).collect();

    expect(result).toMatchObject({ overlays: 1, changes: 1 });
    expect(reader.listPullRequestFiles).toHaveBeenCalledTimes(2);
    expect(reader.getCommitStatuses).toHaveBeenCalledTimes(1);
    expect(reader.getPublishedExports).toHaveBeenCalledWith(
      'rhdh-parasol/rhdh-plugin-export-overlays',
      3099,
    );
    expect(service.createSystemChange).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        occurredAt: '2026-09-03T09:00:00.000Z',
      }),
    );
    expect(service.recordSystemEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: expect.objectContaining({
          kind: 'ci.run.recorded',
          run: expect.objectContaining({
            provider: 'github-commit-status',
            jobName: 'publish',
            conclusion: 'success',
          }),
        }),
      }),
    );
    expect(service.recordSystemEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: expect.objectContaining({
          kind: 'ci.run.recorded',
          run: expect.objectContaining({
            provider: 'github-commit-status',
            jobName: 'smoketest',
            status: 'in_progress',
          }),
        }),
      }),
    );
    expect(service.recordSystemEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: expect.objectContaining({
          kind: 'artifact.recorded',
          artifact: expect.objectContaining({
            reference: 'quay.io/rhdh/global-header:pr_3099__2.0.0',
          }),
        }),
      }),
    );
    expect(service.recordSystemEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: expect.objectContaining({
          kind: 'reference.linked',
          reference: expect.objectContaining({
            author: 'plugin-author',
            updatedAt: '2026-09-03T10:00:00.000Z',
          }),
        }),
      }),
    );
  });

  it('imports recent merged PRs as completed, inactive lifecycle changes', async () => {
    const service = {
      createSystemChange: jest.fn().mockResolvedValue({
        change: { changeId: '18163e4e-b0a5-431b-80f1-4913362d9926' },
      }),
      updateSystemChangeStatus: jest.fn().mockResolvedValue(undefined),
      associationsForEntity: jest.fn().mockResolvedValue([]),
      recordSystemEvent: jest.fn().mockResolvedValue(undefined),
      recordSystemDiagnostic: jest.fn().mockResolvedValue(undefined),
    } as unknown as LifecycleService;
    const catalog = {
      queryEntities: jest.fn().mockResolvedValue({ items: [overlay] }),
    } as unknown as jest.Mocked<CatalogService>;
    const reader: GitHubActionsReader = {
      listRuns: jest.fn().mockResolvedValue([]),
      listJobs: jest.fn(),
      listOpenPullRequests: jest.fn().mockResolvedValue([]),
      listClosedPullRequests: jest.fn().mockResolvedValue([
        {
          number: 3098,
          title: 'Merge the Adoption Insights export fix',
          state: 'closed',
          merged_at: '2026-09-02T10:00:00.000Z',
          closed_at: '2026-09-02T10:00:00.000Z',
          html_url:
            'https://github.com/rhdh-parasol/rhdh-plugin-export-overlays/pull/3098',
          user: { login: 'plugin-author' },
          head: { sha: 'aabb85ef001ddae5af621ecf17e02f7bac9175e3' },
          created_at: '2026-09-01T09:00:00.000Z',
          updated_at: '2026-09-02T10:00:00.000Z',
        },
        {
          number: 3097,
          title: 'Earlier merged Adoption Insights fix',
          state: 'closed',
          merged_at: '2026-08-30T10:00:00.000Z',
          closed_at: '2026-08-30T10:00:00.000Z',
          head: { sha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' },
          created_at: '2026-08-29T09:00:00.000Z',
          updated_at: '2026-08-30T10:00:00.000Z',
        },
        {
          number: 4000,
          title: 'Unrelated merged change',
          state: 'closed',
          merged_at: '2026-09-02T11:00:00.000Z',
          updated_at: '2026-08-01T11:00:00.000Z',
          head: { sha: 'cccccccccccccccccccccccccccccccccccccccc' },
        },
      ]),
      listPullRequestFiles: jest.fn(async (_repository, number) =>
        number === 4000
          ? ['workspaces/adoption-insights/source.json']
          : ['workspaces/global-header/source.json'],
      ),
      getCommitStatuses: jest.fn().mockResolvedValue([
        {
          context: 'publish',
          state: 'success',
          description: 'Published candidate images',
          target_url:
            'https://github.com/rhdh-parasol/rhdh-plugin-export-overlays/actions/runs/3098',
          updated_at: '2026-09-02T10:01:00.000Z',
        },
        {
          context: 'smoketest',
          state: 'success',
          description: 'Smoke tests passed',
          target_url:
            'https://github.com/rhdh-parasol/rhdh-plugin-export-overlays/actions/runs/3098',
          updated_at: '2026-09-02T10:02:00.000Z',
        },
      ]),
    };
    const auth = {
      getOwnServiceCredentials: jest
        .fn()
        .mockResolvedValue(mockCredentials.service('collector')),
    } as unknown as AuthService;

    const result = await new GitHubActionsCollector(
      service,
      catalog,
      auth,
      reader,
      { warn: jest.fn() } as unknown as LoggerService,
      'publish-workspace-plugins.yaml',
      false,
      undefined,
      1,
    ).collect();

    expect(result).toMatchObject({ overlays: 1, changes: 1 });
    expect(reader.listClosedPullRequests).toHaveBeenCalledWith(
      'rhdh-parasol/rhdh-plugin-export-overlays',
    );
    expect(reader.listPullRequestFiles).toHaveBeenCalledTimes(3);
    expect(service.createSystemChange).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId:
          'github:rhdh-parasol/rhdh-plugin-export-overlays:pr:3098:workspace:global-header',
      }),
      expect.objectContaining({
        externalStatus: 'merged',
      }),
    );
    expect(service.updateSystemChangeStatus).toHaveBeenCalledWith(
      '18163e4e-b0a5-431b-80f1-4913362d9926',
      'merged',
    );
  });

  it('uses one idempotent change when PR checks and workflow jobs observe the same PR', async () => {
    const requests: Array<{
      requestId: string;
      title: string;
      summary?: string;
    }> = [];
    const createSystemChange = jest.fn(
      async (input: { requestId: string; title: string; summary?: string }) => {
        requests.push(input);
        return {
          change: { changeId: '18163e4e-b0a5-431b-80f1-4913362d9926' },
        };
      },
    );
    const service = {
      createSystemChange,
      associationsForEntity: jest.fn().mockResolvedValue([]),
      recordSystemEvent: jest.fn().mockResolvedValue(undefined),
      recordSystemDiagnostic: jest.fn().mockResolvedValue(undefined),
    } as unknown as LifecycleService;
    const catalog = {
      queryEntities: jest.fn().mockResolvedValue({ items: [overlay] }),
    } as unknown as jest.Mocked<CatalogService>;
    const reader: GitHubActionsReader = {
      listRuns: jest.fn().mockResolvedValue([
        {
          id: 51,
          run_number: 12,
          run_attempt: 1,
          name: 'Publish',
          status: 'completed',
          conclusion: 'success',
          head_sha: 'aabb85ef001ddae5af621ecf17e02f7bac9175e3',
          updated_at: '2026-09-03T10:04:00.000Z',
          pull_requests: [{ number: 3099 }],
        },
      ]),
      listJobs: jest.fn().mockResolvedValue([
        {
          id: 151,
          name: 'export / workspaces/global-header',
          status: 'completed',
          conclusion: 'success',
        },
      ]),
      listOpenPullRequests: jest.fn().mockResolvedValue([
        {
          number: 3099,
          title: 'Fix Global Header export',
          head: { sha: 'aabb85ef001ddae5af621ecf17e02f7bac9175e3' },
          updated_at: '2026-09-03T10:00:00.000Z',
        },
      ]),
      listPullRequestFiles: jest
        .fn()
        .mockResolvedValue(['workspaces/global-header/source.json']),
      getCommitStatuses: jest.fn().mockResolvedValue([]),
    };
    const auth = {
      getOwnServiceCredentials: jest
        .fn()
        .mockResolvedValue(mockCredentials.service('collector')),
    } as unknown as AuthService;

    await expect(
      new GitHubActionsCollector(service, catalog, auth, reader, {
        warn: jest.fn(),
      } as unknown as LoggerService).collect(),
    ).resolves.toEqual(expect.objectContaining({ overlays: 1 }));
    expect(createSystemChange).toHaveBeenCalledTimes(2);
    expect(requests[0]).toMatchObject({
      requestId:
        'github:rhdh-parasol/rhdh-plugin-export-overlays:pr:3099:workspace:global-header',
      title: 'PR #3099 · global-header',
      summary: 'Fix Global Header export',
    });
    expect(requests[1]).toMatchObject(requests[0]);
  });

  it('resolves persisted subjects directly and reuses repository reads across subjects', async () => {
    const secondOverlay: Entity = {
      ...overlay,
      metadata: {
        ...overlay.metadata,
        name: 'overlay-adoption-insights',
        annotations: {
          ...overlay.metadata.annotations,
          'rhdh.io/overlay-workspace': 'adoption-insights',
        },
      },
    };
    const overlaysByRef = new Map([
      ['component:default/overlay-global-header', overlay],
      ['component:default/overlay-adoption-insights', secondOverlay],
    ]);
    const service = {
      getSubjectForEntity: jest.fn(async (entityRef: string) => ({
        id: entityRef,
        overlayEntityRef: entityRef.includes('adoption')
          ? 'component:default/overlay-adoption-insights'
          : 'component:default/overlay-global-header',
      })),
      reconcileSubject: jest.fn().mockResolvedValue(undefined),
      updateSyncState: jest.fn().mockResolvedValue(undefined),
      associationsForEntity: jest.fn().mockResolvedValue([]),
      recordSystemDiagnostic: jest.fn().mockResolvedValue(undefined),
    } as unknown as LifecycleService;
    const catalog = {
      getEntityByRef: jest.fn(async (entityRef: string) =>
        overlaysByRef.get(entityRef),
      ),
      queryEntities: jest.fn(),
    } as unknown as jest.Mocked<CatalogService>;
    const reader: GitHubActionsReader = {
      listRuns: jest.fn().mockResolvedValue([]),
      listJobs: jest.fn(),
    };
    const auth = {
      getOwnServiceCredentials: jest
        .fn()
        .mockResolvedValue(mockCredentials.service('collector')),
    } as unknown as AuthService;
    const collector = new GitHubActionsCollector(
      service,
      catalog,
      auth,
      reader,
      { warn: jest.fn() } as unknown as LoggerService,
    );

    await Promise.all([
      collector.refreshSubject('component:default/overlay-global-header'),
      collector.refreshSubject('component:default/overlay-adoption-insights'),
    ]);

    expect(catalog.queryEntities).not.toHaveBeenCalled();
    expect(reader.listRuns).toHaveBeenCalledTimes(1);
  });

  it('refreshes a queued subject without waiting for the bootstrap queue', async () => {
    const service = {
      getSubjectForEntity: jest.fn().mockResolvedValue(undefined),
      reconcileSubject: jest.fn().mockResolvedValue(undefined),
      updateSyncState: jest.fn().mockResolvedValue(undefined),
      associationsForEntity: jest.fn().mockResolvedValue([]),
      recordSystemDiagnostic: jest.fn().mockResolvedValue(undefined),
    } as unknown as LifecycleService;
    const catalog = {
      queryEntities: jest.fn().mockResolvedValue({ items: [overlay] }),
      getEntityByRef: jest.fn(),
    } as unknown as jest.Mocked<CatalogService>;
    let bootstrapStarted!: () => void;
    const started = new Promise<void>(resolve => {
      bootstrapStarted = resolve;
    });
    let releaseBootstrapRuns!: () => void;
    const bootstrapRuns = new Promise<GitHubWorkflowRun[]>(resolve => {
      releaseBootstrapRuns = () => resolve([]);
    });
    let listRunsCalls = 0;
    const reader: GitHubActionsReader = {
      listRuns: jest.fn(() => {
        listRunsCalls += 1;
        if (listRunsCalls === 1) {
          bootstrapStarted();
          return bootstrapRuns;
        }
        return Promise.resolve([]);
      }),
      listJobs: jest.fn(),
    };
    const auth = {
      getOwnServiceCredentials: jest
        .fn()
        .mockResolvedValue(mockCredentials.service('collector')),
    } as unknown as AuthService;
    const collector = new GitHubActionsCollector(
      service,
      catalog,
      auth,
      reader,
      { warn: jest.fn() } as unknown as LoggerService,
    );

    const bootstrap = collector.collect();
    await started;
    const prioritized = collector.refreshSubject(
      'component:default/overlay-demo',
    );
    // The priority path shares the bootstrap cache. Let the currently
    // executing run-list request finish, then both paths reuse its result.
    releaseBootstrapRuns();
    await expect(prioritized).resolves.toBeUndefined();
    expect(reader.listRuns).toHaveBeenCalledTimes(1);
    await bootstrap;
  });

  it('honors a persisted rate-limit cooldown before querying GitHub', async () => {
    const service = {
      getSubjectForEntity: jest.fn().mockResolvedValue({
        id: 'subject-id',
        overlayEntityRef: 'component:default/overlay-demo',
      }),
      reconcileSubject: jest.fn().mockResolvedValue(undefined),
      getSyncStateForEntity: jest.fn().mockResolvedValue({
        status: 'rate_limited',
        rateLimitResetAt: new Date(Date.now() + 60_000).toISOString(),
      }),
      updateSyncState: jest.fn().mockResolvedValue(undefined),
    } as unknown as LifecycleService;
    const catalog = {
      getEntityByRef: jest.fn().mockResolvedValue(overlay),
    } as unknown as jest.Mocked<CatalogService>;
    const reader: GitHubActionsReader = {
      listRuns: jest.fn().mockResolvedValue([]),
      listJobs: jest.fn(),
    };
    const auth = {
      getOwnServiceCredentials: jest
        .fn()
        .mockResolvedValue(mockCredentials.service('collector')),
    } as unknown as AuthService;
    const collector = new GitHubActionsCollector(
      service,
      catalog,
      auth,
      reader,
      { warn: jest.fn() } as unknown as LoggerService,
    );

    await collector.refreshSubject('component:default/overlay-demo');

    expect(reader.listRuns).not.toHaveBeenCalled();
    expect(service.updateSyncState).toHaveBeenCalledWith(
      'component:default/overlay-demo',
      expect.objectContaining({ status: 'rate_limited' }),
    );
  });
});
