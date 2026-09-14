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
import { mockCredentials, mockServices } from '@backstage/backend-test-utils';
import type { Entity } from '@backstage/catalog-model';
import { NotAllowedError, NotFoundError } from '@backstage/errors';
import type { CatalogService } from '@backstage/plugin-catalog-node';
import { AuthorizeResult } from '@backstage/plugin-permission-common';
import { LifecycleStore } from '../database/LifecycleStore';
import { LifecycleService } from './LifecycleService';

const overlay: Entity = {
  apiVersion: 'backstage.io/v1alpha1',
  kind: 'Component',
  metadata: {
    name: 'overlay-example',
    namespace: 'default',
    title: 'Example overlay',
    annotations: {
      'rhdh.io/source-entity-ref': 'component:default/example',
      'rhdh.io/extensions-plugin-refs': 'plugin:default/example',
      'rhdh.io/extensions-package-refs': 'package:default/example-frontend',
    },
  },
  spec: { type: 'rhdh-overlay-workspace', owner: 'group:default/platform' },
};
const source: Entity = {
  apiVersion: 'backstage.io/v1alpha1',
  kind: 'Component',
  metadata: { name: 'example', namespace: 'default', title: 'Example source' },
  spec: { type: 'library', owner: 'group:default/platform' },
};
const plugin: Entity = {
  apiVersion: 'extensions.backstage.io/v1alpha1',
  kind: 'Plugin',
  metadata: { name: 'example', namespace: 'default', title: 'Example plugin' },
  spec: { packages: ['package:default/example-frontend'] },
};
const packageEntity: Entity = {
  apiVersion: 'extensions.backstage.io/v1alpha1',
  kind: 'Package',
  metadata: { name: 'example-frontend', namespace: 'default' },
  spec: {
    packageName: '@example/plugin-example',
    version: '2.0.0',
    backstage: { supportedVersions: '1.54.4' },
    support: { provider: 'Red Hat', level: 'tech-preview' },
  },
};

function storeMock() {
  return {
    createChange: jest.fn(),
    appendEvent: jest.fn(),
    getContext: jest.fn().mockResolvedValue({ changes: [], events: [] }),
    getChangeDetails: jest.fn().mockResolvedValue([]),
    getAssociations: jest.fn().mockResolvedValue([]),
  } as unknown as jest.Mocked<LifecycleStore>;
}
function catalogMock(entities: Entity[]) {
  return {
    getEntityByRef: jest.fn(async (entityRef: string) =>
      entities.find(
        entity =>
          `${entity.kind.toLocaleLowerCase('en-US')}:${
            entity.metadata.namespace ?? 'default'
          }/${entity.metadata.name}` === entityRef,
      ),
    ),
  } as unknown as jest.Mocked<CatalogService>;
}
function allowedPermissions() {
  return mockServices.permissions.mock({
    authorize: async requests =>
      requests.map(() => ({ result: AuthorizeResult.ALLOW })),
  });
}

describe('LifecycleService', () => {
  const credentials = mockCredentials.user('user:default/tester');

  it('returns generic context with related Catalog entities', async () => {
    const store = storeMock();
    const catalog = catalogMock([overlay, source, plugin, packageEntity]);
    const service = new LifecycleService(store, catalog, allowedPermissions());
    const context = await service.getContext(
      { entityRef: 'component:default/overlay-example', eventLimit: 100 },
      credentials,
    );
    expect(context.requestedEntityRef).toBe(
      'component:default/overlay-example',
    );
    expect(context.subject.catalogStatus).toBe('available');
    expect(context.relatedEntities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'package',
          packageName: '@example/plugin-example',
          version: '2.0.0',
          supportedVersions: ['1.54.4'],
          support: 'Red Hat · tech-preview',
        }),
      ]),
    );
    expect(catalog.getEntityByRef).toHaveBeenCalledWith(
      'component:default/overlay-example',
      { credentials },
    );
  });

  it('does not present an unresolved Package binding as an available release', async () => {
    const service = new LifecycleService(
      storeMock(),
      catalogMock([overlay, source, plugin]),
      allowedPermissions(),
    );

    const context = await service.getContext(
      { entityRef: 'component:default/overlay-example', eventLimit: 100 },
      credentials,
    );

    expect(context.delivery?.releasedPackages).toEqual([]);
    expect(context.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'catalog-entity-missing',
          entityRef: 'package:default/example-frontend',
        }),
      ]),
    );
  });

  it('derives delivery status, released packages, candidates, and both mainline builds', async () => {
    const candidateId = '18163e4e-b0a5-431b-80f1-4913362d9926';
    const mainlineId = '28163e4e-b0a5-431b-80f1-4913362d9926';
    const candidateSummary = {
      changeId: candidateId,
      subjectEntityRef: 'component:default/overlay-example',
      origin: 'github-actions' as const,
      externalChangeKey: 'github:example/overlays:pr:42:workspace:example',
      scope: 'pull_request' as const,
      externalStatus: 'open' as const,
      lastOccurredAt: '2026-09-03T10:02:00.000Z',
      title: 'PR #42 · example',
      summary: 'Prepare the next example release',
      currentPhase: 'verification' as const,
      currentState: 'pending' as const,
      createdBy: 'system:plugin-lifecycle',
      createdAt: '2026-09-03T10:00:00.000Z',
      updatedAt: '2026-09-03T10:02:00.000Z',
    };
    const mainlineSummary = {
      ...candidateSummary,
      changeId: mainlineId,
      externalChangeKey: 'github:example/overlays:ref:main:commit:abc',
      scope: 'branch' as const,
      externalStatus: 'open' as const,
      title: 'example mainline',
      currentPhase: 'build' as const,
      currentState: 'failed' as const,
      updatedAt: '2026-09-03T10:03:00.000Z',
    };
    const candidateProjection = {
      phase: 'verification' as const,
      state: 'pending' as const,
      summary: 'Smoke test is pending',
      references: [
        {
          type: 'pull_request' as const,
          externalId: '42',
          title: 'Prepare the next example release',
          url: 'https://github.com/example/overlays/pull/42',
        },
        {
          type: 'source' as const,
          externalId: 'abcdef1234567890',
          title: 'Overlay revision abcdef123456',
          url: 'https://github.com/example/overlays/commit/abcdef1234567890',
        },
      ],
      ciRuns: [
        {
          provider: 'github-commit-status' as const,
          repository: 'example/overlays',
          workflow: 'GitHub commit status',
          runId: 'abcdef1234567890:publish',
          runAttempt: 1,
          jobName: 'publish',
          status: 'completed' as const,
          conclusion: 'success' as const,
          commitSha: 'abcdef1234567890',
          updatedAt: '2026-09-03T10:01:00.000Z',
          url: 'https://github.com/example/overlays/actions/runs/42',
          winning: false,
          fixture: false,
        },
        {
          provider: 'github-actions' as const,
          repository: 'example/overlays',
          workflow: 'Another PR workflow',
          runId: 'unrelated-failure',
          runAttempt: 1,
          jobName: 'export / workspaces/example',
          status: 'completed' as const,
          conclusion: 'failure' as const,
          updatedAt: '2026-09-03T10:02:00.000Z',
          url: 'https://github.com/example/overlays/actions/runs/43',
          winning: false,
          fixture: false,
        },
      ],
      verifications: [],
      artifacts: [
        {
          artifactType: 'oci' as const,
          reference: 'quay.io/example/plugin:pr-42',
        },
      ],
      agentAttempts: [],
      phaseStates: [
        {
          phase: 'build' as const,
          state: 'succeeded' as const,
          summary: 'Published candidate images',
          evidenceUrl: 'https://github.com/example/overlays/actions/runs/42',
          updatedAt: '2026-09-03T10:01:00.000Z',
        },
        {
          phase: 'verification' as const,
          state: 'pending' as const,
          summary: 'Smoke test is pending',
          evidenceUrl: 'https://github.com/example/overlays/actions/runs/42',
          updatedAt: '2026-09-03T10:02:00.000Z',
        },
      ],
      updatedAt: '2026-09-03T10:02:00.000Z',
    };
    const mainlineProjection = {
      phase: 'build' as const,
      state: 'failed' as const,
      summary: 'Mainline failed',
      references: [],
      ciRuns: [
        {
          provider: 'github-actions' as const,
          repository: 'example/overlays',
          workflow: 'Publish',
          branch: 'main',
          runId: 'older-success',
          runNumber: 40,
          runAttempt: 1,
          jobId: 'job-40',
          jobName: 'export / workspaces/example',
          status: 'completed' as const,
          conclusion: 'success' as const,
          updatedAt: '2026-09-03T09:00:00.000Z',
          url: 'https://github.com/example/overlays/actions/runs/40',
          winning: false,
          fixture: false,
        },
        {
          provider: 'github-actions' as const,
          repository: 'example/overlays',
          workflow: 'Publish',
          branch: 'main',
          runId: 'latest-failure',
          runNumber: 41,
          runAttempt: 2,
          jobId: 'job-41',
          jobName: 'export / workspaces/example',
          status: 'completed' as const,
          conclusion: 'failure' as const,
          updatedAt: '2026-09-03T10:03:00.000Z',
          url: 'https://github.com/example/overlays/actions/runs/41',
          winning: false,
          fixture: false,
        },
      ],
      verifications: [],
      artifacts: [],
      agentAttempts: [],
      updatedAt: '2026-09-03T10:03:00.000Z',
    };
    const store = storeMock();
    store.getContext.mockResolvedValue({
      changes: [candidateSummary, mainlineSummary],
      selectedChange: candidateSummary,
      projection: candidateProjection,
      events: [],
    });
    store.getChangeDetails.mockResolvedValue([
      { summary: candidateSummary, projection: candidateProjection },
      { summary: mainlineSummary, projection: mainlineProjection },
    ]);
    store.getAssociations.mockResolvedValue([
      {
        entityRef: 'component:default/overlay-example',
        role: 'subject',
        relationSource: 'subject',
      },
      {
        entityRef: 'component:default/example',
        role: 'source',
        relationSource: 'catalog-relation',
      },
      {
        entityRef: 'plugin:default/example',
        role: 'extension-plugin',
        relationSource: 'catalog-annotation',
      },
      {
        entityRef: 'package:default/example-frontend',
        role: 'package',
        relationSource: 'catalog-annotation',
      },
    ]);
    const packageWithArtifact = {
      ...packageEntity,
      spec: {
        ...packageEntity.spec,
        dynamicArtifact:
          'oci://quay.io/example/plugin:2.0.0@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      },
    };
    const service = new LifecycleService(
      store,
      catalogMock([overlay, source, plugin, packageWithArtifact]),
      allowedPermissions(),
    );

    const context = await service.getContext(
      { entityRef: 'component:default/overlay-example', eventLimit: 100 },
      credentials,
    );

    expect(context.delivery).toMatchObject({
      status: 'in_progress',
      workspace: 'example',
      releasedPackages: [
        expect.objectContaining({
          version: '2.0.0',
          evidence: 'catalog_reported',
        }),
      ],
      activeCandidates: [
        expect.objectContaining({
          pullRequestNumber: 42,
          publishStatus: 'success',
          publishUrl: 'https://github.com/example/overlays/actions/runs/42',
          smokeTestStatus: 'pending',
          candidateImages: [
            expect.objectContaining({
              reference: 'quay.io/example/plugin:pr-42',
            }),
          ],
        }),
      ],
      mainline: {
        latestBuild: expect.objectContaining({ runId: 'latest-failure' }),
        latestSuccessfulBuild: expect.objectContaining({
          runId: 'older-success',
        }),
      },
    });
  });

  it('keeps history readable when the requested Catalog entity is missing', async () => {
    const service = new LifecycleService(
      storeMock(),
      catalogMock([]),
      allowedPermissions(),
    );
    const context = await service.getContext(
      { entityRef: 'component:default/removed', eventLimit: 100 },
      credentials,
    );
    expect(context.subject.catalogStatus).toBe('missing');
    expect(context.warnings[0].code).toBe('requested-entity-missing');
  });

  it('requires an existing overlay Component before creating a change', async () => {
    const store = storeMock();
    const service = new LifecycleService(
      store,
      catalogMock([]),
      allowedPermissions(),
    );
    await expect(
      service.createChange(
        {
          requestId: 'missing-overlay',
          subjectEntityRef: 'component:default/missing',
          title: 'Missing overlay',
          initialReferences: [],
        },
        credentials,
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(store.createChange).not.toHaveBeenCalled();
  });

  it('rejects non-overlay entities for writes', async () => {
    const service = new LifecycleService(
      storeMock(),
      catalogMock([source]),
      allowedPermissions(),
    );
    await expect(
      service.createChange(
        {
          requestId: 'wrong-kind',
          subjectEntityRef: 'component:default/example',
          title: 'Wrong kind',
          initialReferences: [],
        },
        credentials,
      ),
    ).rejects.toThrow('rhdh-overlay-workspace');
  });

  it('enforces permissions and human credentials', async () => {
    const denied = mockServices.permissions.mock({
      authorize: async requests =>
        requests.map(() => ({ result: AuthorizeResult.DENY })),
    });
    const service = new LifecycleService(
      storeMock(),
      catalogMock([overlay]),
      denied,
    );
    await expect(
      service.getContext(
        { entityRef: 'component:default/overlay-example', eventLimit: 100 },
        credentials,
      ),
    ).rejects.toBeInstanceOf(NotAllowedError);
    await expect(
      service.getContext(
        { entityRef: 'component:default/overlay-example', eventLimit: 100 },
        mockCredentials.service('pipeline'),
      ),
    ).rejects.toBeInstanceOf(NotAllowedError);
  });

  it('returns persisted context when a live refresh exceeds the wait budget', async () => {
    jest.useFakeTimers();
    let finishRefresh!: () => void;
    const service = new LifecycleService(
      storeMock(),
      catalogMock([overlay, source, plugin, packageEntity]),
      allowedPermissions(),
      1_000,
    );
    service.setRefresher(
      () =>
        new Promise<void>(resolve => {
          finishRefresh = resolve;
        }),
    );

    try {
      const pending = service.refresh(
        'component:default/overlay-example',
        credentials,
      );
      await jest.advanceTimersByTimeAsync(1_000);
      await expect(pending).resolves.toEqual(
        expect.objectContaining({
          requestedEntityRef: 'component:default/overlay-example',
        }),
      );
    } finally {
      finishRefresh();
      jest.useRealTimers();
    }
  });

  it('returns cached context when a live refresh fails', async () => {
    const service = new LifecycleService(
      storeMock(),
      catalogMock([overlay, source, plugin, packageEntity]),
      allowedPermissions(),
    );
    service.setRefresher(async () => {
      throw new Error('GitHub returned 403');
    });

    await expect(
      service.refresh('component:default/overlay-example', credentials),
    ).resolves.toEqual(
      expect.objectContaining({
        sync: expect.objectContaining({
          refreshAttempted: true,
          errorSummary: 'GitHub returned 403',
        }),
      }),
    );
  });
});
