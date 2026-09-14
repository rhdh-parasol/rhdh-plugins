/* Copyright Red Hat, Inc. */
import { renderInTestApp } from '@backstage/frontend-test-utils';
import type { Delivery } from '@red-hat-developer-hub/backstage-plugin-lifecycle-common';
import { screen } from '@testing-library/react';
import { DeliveryOverview } from './DeliveryOverview';

const delivery: Delivery = {
  status: 'attention_required',
  statusReason: 'The candidate publish check failed.',
  workspace: 'example',
  releasedPackages: [
    {
      entityRef: 'package:rhdh/example',
      packageName: '@example/plugin',
      version: '1.2.3',
      ociReference: 'quay.io/example/plugin:1.2.3',
      supportedVersions: ['1.54'],
      evidence: 'catalog_reported',
    },
  ],
  activeCandidates: [
    {
      changeId: '00000000-0000-4000-8000-000000000001',
      title: 'Update example plugin',
      pullRequestNumber: 42,
      pullRequestUrl: 'https://github.com/example/repo/pull/42',
      updatedAt: '2026-09-01T10:00:00.000Z',
      publishStatus: 'failure',
      smokeTestStatus: 'not_run',
      candidateImages: [],
    },
  ],
  mainline: {
    latestBuild: {
      runId: '99',
      runNumber: 99,
      runAttempt: 1,
      status: 'completed',
      conclusion: 'failure',
      commitSha: '0123456789abcdef',
      jobName: 'workspaces/example',
      url: 'https://github.com/example/repo/actions/runs/99',
    },
  },
  freshness: { syncStatus: 'succeeded', stale: false },
};

describe('DeliveryOverview', () => {
  it('keeps release, candidate, and mainline evidence distinct', async () => {
    await renderInTestApp(<DeliveryOverview delivery={delivery} />);
    expect(
      screen.getByText(/Available in Extensions Catalog/),
    ).toBeInTheDocument();
    expect(screen.getByText('Open candidates')).toBeInTheDocument();
    expect(screen.getByText('Mainline health')).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: /Update example plugin/ }),
    ).toHaveAttribute('href', delivery.activeCandidates[0].pullRequestUrl);
    expect(screen.getByText('Latest build')).toBeInTheDocument();
  });
});
