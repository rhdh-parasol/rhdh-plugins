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
import { renderInTestApp } from '@backstage/frontend-test-utils';
import type { LifecycleContext } from '@red-hat-developer-hub/backstage-plugin-lifecycle-common';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { LifecycleDashboard } from './EntityPluginLifecycleContent';

const time = '2026-09-01T10:00:00.000Z';
const changeId = '18163e4e-b0a5-431b-80f1-4913362d9926';
const context: LifecycleContext = {
  schemaVersion: 2,
  requestedEntityRef: 'component:default/overlay-example',
  subject: {
    entityRef: 'component:default/overlay-example',
    role: 'subject',
    catalogStatus: 'available',
    kind: 'Component',
    name: 'overlay-example',
    namespace: 'default',
    supportedVersions: [],
  },
  relatedEntities: [],
  warnings: [],
  changes: [
    {
      changeId,
      subjectEntityRef: 'component:default/overlay-example',
      origin: 'fixture',
      title: 'Upgrade example plugin',
      currentPhase: 'verification',
      currentState: 'blocked',
      createdBy: 'user:default/tester',
      createdAt: time,
      updatedAt: time,
    },
  ],
  selectedChange: {
    changeId,
    subjectEntityRef: 'component:default/overlay-example',
    origin: 'fixture',
    title: 'Upgrade example plugin',
    currentPhase: 'verification',
    currentState: 'blocked',
    createdBy: 'user:default/tester',
    createdAt: time,
    updatedAt: time,
  },
  projection: {
    phase: 'verification',
    state: 'blocked',
    summary: 'Verification blocked',
    blocker: 'Missing Legacy export',
    references: [],
    ciRuns: [],
    verifications: [],
    artifacts: [],
    agentAttempts: [],
    updatedAt: time,
  },
  events: [
    {
      eventId: 'event-1',
      changeId,
      schemaVersion: 2,
      occurredAt: time,
      ingestedAt: time,
      actorRef: 'user:default/tester',
      producer: 'test',
      payload: {
        kind: 'phase.updated',
        phase: 'verification',
        state: 'blocked',
        summary: 'Verification blocked',
        blocker: 'Missing Legacy export',
      },
    },
  ],
};

describe('LifecycleDashboard', () => {
  it('renders the phase rail, evidence timeline, and provenance rail', async () => {
    const onViewAt = jest.fn();
    await renderInTestApp(
      <LifecycleDashboard
        context={context}
        onChangeSelected={jest.fn()}
        onViewAt={onViewAt}
        onReturnToCurrent={jest.fn()}
      />,
    );
    expect(
      screen.getByRole('heading', { name: 'Upgrade example plugin' }),
    ).toBeInTheDocument();
    expect(screen.getByText('Current blocker')).toBeInTheDocument();
    expect(screen.getByText('Provenance')).toBeInTheDocument();
    expect(
      screen.getByRole('list', { name: 'Lifecycle phases' }),
    ).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole('button', { name: 'View state here' }),
    );
    expect(onViewAt).toHaveBeenCalledWith(context.events[0]);
  });

  it('exposes actionable delivery evidence as descriptive links', async () => {
    await renderInTestApp(
      <LifecycleDashboard
        context={{
          ...context,
          delivery: {
            status: 'attention_required',
            statusReason: 'The candidate publish check failed.',
            ownerRef: 'group:default/platform',
            workspace: 'example',
            releasedPackages: [
              {
                entityRef: 'package:rhdh/example',
                packageName: '@example/plugin',
                version: '2.0.0',
                ociReference: 'oci://quay.io/example/plugin:2.0.0',
                supportedVersions: ['1.54.4'],
                evidence: 'catalog_reported',
              },
            ],
            activeCandidates: [
              {
                changeId,
                title: 'PR #42 · example',
                pullRequestNumber: 42,
                pullRequestUrl: 'https://github.com/example/overlays/pull/42',
                sourceRevision: 'abcdef1234567890',
                sourceUrl:
                  'https://github.com/example/source/commit/abcdef1234567890',
                updatedAt: time,
                publishStatus: 'failure',
                publishUrl:
                  'https://github.com/example/overlays/actions/runs/42',
                smokeTestStatus: 'not_run',
                candidateImages: [],
                nextAction: 'Inspect the failing check.',
                nextActionUrl:
                  'https://github.com/example/overlays/actions/runs/42',
                nextActionLabel: 'Inspect failed publish check',
              },
            ],
            mainline: {},
            nextAction: 'Inspect the failing check.',
            nextActionUrl:
              'https://github.com/example/overlays/actions/runs/42',
            nextActionLabel: 'Inspect failed publish check',
            freshness: {
              syncStatus: 'succeeded',
              lastSuccessAt: time,
              stale: false,
            },
          },
        }}
        onChangeSelected={jest.fn()}
        onViewAt={jest.fn()}
        onReturnToCurrent={jest.fn()}
        refreshResult={{ changesAdded: 0, eventsAdded: 0 }}
      />,
    );

    expect(
      screen.getByText('GitHub refresh complete · no new evidence'),
    ).toBeInTheDocument();

    expect(
      screen.getByRole('link', { name: '@example/plugin' }),
    ).toHaveAttribute('href', '/catalog/rhdh/package/example');
    expect(
      screen.getByRole('link', { name: /PR #42 · example/ }),
    ).toHaveAttribute('href', 'https://github.com/example/overlays/pull/42');
    expect(
      screen.getByRole('link', { name: /View publish check/ }),
    ).toHaveAttribute(
      'href',
      'https://github.com/example/overlays/actions/runs/42',
    );
    expect(
      screen.getByRole('link', { name: /Source abcdef123456/ }),
    ).toHaveAttribute(
      'href',
      'https://github.com/example/source/commit/abcdef1234567890',
    );
  });

  it('shows historical mode and returns to current state', async () => {
    const onReturn = jest.fn();
    await renderInTestApp(
      <LifecycleDashboard
        context={{ ...context, asOf: time }}
        onChangeSelected={jest.fn()}
        onViewAt={jest.fn()}
        onReturnToCurrent={onReturn}
      />,
    );
    expect(screen.getByText(/Live updates are paused/)).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole('button', { name: 'Return to current' }),
    );
    expect(onReturn).toHaveBeenCalled();
  });

  it('explains when a historical timestamp predates the change', async () => {
    const onReturn = jest.fn();
    await renderInTestApp(
      <LifecycleDashboard
        context={{
          ...context,
          projection: undefined,
          events: [],
          asOf: '1970-01-01T00:00:00.000Z',
        }}
        onChangeSelected={jest.fn()}
        onViewAt={jest.fn()}
        onReturnToCurrent={onReturn}
      />,
    );

    expect(
      screen.getByText('No lifecycle state existed at this time'),
    ).toBeVisible();
    await userEvent.click(
      screen.getByRole('button', { name: 'Return to current' }),
    );
    expect(onReturn).toHaveBeenCalled();
  });

  it('renders empty and catalog-missing states without losing retained history', async () => {
    const { rerender } = await renderInTestApp(
      <LifecycleDashboard
        context={{
          ...context,
          changes: [],
          selectedChange: undefined,
          projection: undefined,
          events: [],
        }}
        onChangeSelected={jest.fn()}
        onViewAt={jest.fn()}
        onReturnToCurrent={jest.fn()}
      />,
    );
    expect(
      screen.getByText('No matching lifecycle evidence was found.'),
    ).toBeVisible();

    rerender(
      <LifecycleDashboard
        context={{
          ...context,
          subject: { ...context.subject, catalogStatus: 'missing' },
        }}
        onChangeSelected={jest.fn()}
        onViewAt={jest.fn()}
        onReturnToCurrent={jest.fn()}
      />,
    );
    expect(
      screen.getByText(/no longer available in the Catalog/),
    ).toBeVisible();
  });

  it('offers GitHub refresh directly from the lifecycle empty state', async () => {
    const onRefresh = jest.fn();
    await renderInTestApp(
      <LifecycleDashboard
        context={{
          ...context,
          changes: [],
          selectedChange: undefined,
          projection: undefined,
          events: [],
          delivery: {
            status: 'unknown',
            statusReason: 'No delivery evidence has been collected.',
            ownerRef: 'group:default/platform',
            workspace: 'example',
            releasedPackages: [],
            activeCandidates: [],
            mainline: {},
            freshness: { syncStatus: 'empty', stale: false },
          },
          sync: {
            status: 'empty',
            refreshAttempted: false,
            stale: false,
            canRefresh: true,
          },
        }}
        onChangeSelected={jest.fn()}
        onViewAt={jest.fn()}
        onReturnToCurrent={jest.fn()}
        onRefresh={onRefresh}
      />,
    );

    const refreshButtons = screen.getAllByRole('button', {
      name: 'Refresh from GitHub',
    });
    expect(refreshButtons).toHaveLength(2);
    await userEvent.click(refreshButtons[1]);
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(
      screen.getByText(
        'The last GitHub refresh found no matching lifecycle evidence.',
      ),
    ).toBeVisible();
  });

  it('selects another change and renders immutable provenance', async () => {
    const onChangeSelected = jest.fn();
    const richContext: LifecycleContext = {
      ...context,
      changes: [
        ...context.changes,
        {
          ...context.changes[0],
          changeId: 'e0068ad4-8f88-4b5c-813b-caad42248010',
          title: 'Second plugin change',
        },
        {
          ...context.changes[0],
          changeId: 'c2e26748-683e-42f8-3856-665fd7cd6c2d',
          origin: 'github-actions',
          scope: 'branch',
          title: 'adoption-insights mainline export',
        },
      ],
      relatedEntities: [
        {
          entityRef: 'package:default/example',
          role: 'package',
          catalogStatus: 'available',
          kind: 'Package',
          namespace: 'default',
          name: 'example',
          packageName: '@example/plugin-example',
          version: '2.0.0',
          supportedVersions: ['1.54.4'],
        },
      ],
      projection: {
        ...context.projection!,
        references: [
          {
            type: 'source',
            externalId: 'aabb85ef001ddae5af621ecf17e02f7bac9175e3',
            title: 'Source revision',
            url: 'https://github.com/example/repo/commit/aabb85e',
          },
        ],
        winningRun: {
          provider: 'github-actions',
          workflow: 'Publish',
          runId: '42',
          attempt: 1,
          status: 'completed',
          conclusion: 'success',
          commitSha: 'aabb85ef001ddae5af621ecf17e02f7bac9175e3',
          winning: true,
          fixture: false,
        },
        artifacts: [
          {
            artifactType: 'oci',
            reference: 'oci://ghcr.io/example/plugin:2.0.0',
            digest:
              'sha256:58bf836bfcfb73e6866d3288db974218c059b226f6d4a8c6d776ac3b7df2f332',
          },
        ],
      },
    };

    await renderInTestApp(
      <LifecycleDashboard
        context={richContext}
        onChangeSelected={onChangeSelected}
        onViewAt={jest.fn()}
        onReturnToCurrent={jest.fn()}
      />,
    );

    expect(screen.getByText('sha256:58bf836bfcfb7')).toBeVisible();
    expect(screen.getAllByText('@example/plugin-example')).toHaveLength(1);
    expect(screen.getAllByText('Evidence not recorded')).toHaveLength(2);
    await userEvent.click(
      screen.getByRole('button', { name: /Upgrade example plugin Change/ }),
    );
    expect(
      screen.queryByRole('option', {
        name: /adoption-insights mainline export/,
      }),
    ).not.toBeInTheDocument();
    await userEvent.click(
      screen.getByRole('option', { name: /Second plugin change/ }),
    );
    expect(onChangeSelected).toHaveBeenCalledWith(
      'e0068ad4-8f88-4b5c-813b-caad42248010',
    );
  });

  it('labels synthetic CI evidence and reports stale refreshes', async () => {
    const onRetry = jest.fn();
    const fixtureRun = {
      provider: 'github-actions',
      workflow: 'Demo verification',
      runId: 'fixture-run-1',
      attempt: 1,
      status: 'completed' as const,
      conclusion: 'success' as const,
      winning: true,
      fixture: true,
    };
    await renderInTestApp(
      <LifecycleDashboard
        context={{
          ...context,
          projection: {
            ...context.projection!,
            winningRun: fixtureRun,
            ciRuns: [fixtureRun],
          },
          events: [
            {
              ...context.events[0],
              eventId: 'fixture-event',
              payload: { kind: 'ci.run.recorded', run: fixtureRun },
            },
          ],
        }}
        onChangeSelected={jest.fn()}
        onViewAt={jest.fn()}
        onReturnToCurrent={jest.fn()}
        refreshError={new Error('Backend unavailable')}
        onRetry={onRetry}
      />,
    );

    expect(screen.getByText('Fixture data — not a real CI run')).toBeVisible();
    expect(
      screen.getByText(/Showing the last known lifecycle state/),
    ).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalled();
  });

  it('shows the last successful build and image while the selected change is failing', async () => {
    const failedContext: LifecycleContext = {
      ...context,
      changes: [
        {
          ...context.changes[0],
          currentPhase: 'build',
          currentState: 'failed',
          title: 'Current failed export',
        },
      ],
      selectedChange: {
        ...context.selectedChange!,
        currentPhase: 'build',
        currentState: 'failed',
        title: 'Current failed export',
      },
      projection: {
        ...context.projection!,
        phase: 'build',
        state: 'failed',
        blocker: 'The latest export failed',
      },
      lastSuccessfulPublication: {
        change: {
          ...context.changes[0],
          title: 'Previous successful export',
          currentPhase: 'publication',
          currentState: 'succeeded',
        },
        run: {
          provider: 'github-actions',
          workflow: 'Publish',
          runId: '42',
          attempt: 1,
          status: 'completed',
          conclusion: 'success',
          winning: true,
          fixture: true,
          url: 'https://github.com/example/actions/runs/42',
        },
        artifacts: [
          {
            artifactType: 'oci',
            name: 'Example plugin image',
            reference: 'oci://ghcr.io/example/plugin:1.0.0',
            version: '1.0.0',
            digest:
              'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
          },
        ],
      },
    };

    await renderInTestApp(
      <LifecycleDashboard
        context={failedContext}
        onChangeSelected={jest.fn()}
        onViewAt={jest.fn()}
        onReturnToCurrent={jest.fn()}
      />,
    );

    expect(
      screen.getByRole('heading', { name: 'Last attested publication' }),
    ).toBeVisible();
    expect(screen.getByText('Fixture data — not a real CI run')).toBeVisible();
    expect(screen.getByText('Example plugin image')).toBeVisible();
    expect(
      screen.getByText(
        'Digest sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      ),
    ).toBeVisible();
  });
});
