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
import { renderTestApp } from '@backstage/frontend-test-utils';
import { createTestEntityPage } from '@backstage/plugin-catalog-react/testUtils';
import type { LifecycleContext } from '@red-hat-developer-hub/backstage-plugin-lifecycle-common';
import { screen } from '@testing-library/react';
import { pluginLifecycleApiRef, type PluginLifecycleApi } from './api';
import pluginLifecyclePlugin, {
  entityPluginLifecycleContent,
  pluginLifecycleApi,
} from './index';

const entity = {
  apiVersion: 'backstage.io/v1alpha1',
  kind: 'Component',
  metadata: { namespace: 'default', name: 'overlay-example' },
  spec: { type: 'rhdh-overlay-workspace' },
};

const emptyContext: LifecycleContext = {
  schemaVersion: 2,
  requestedEntityRef: 'component:default/overlay-example',
  subject: {
    entityRef: 'component:default/overlay-example',
    role: 'subject',
    catalogStatus: 'available',
    kind: 'Component',
    namespace: 'default',
    name: 'overlay-example',
    supportedVersions: [],
  },
  relatedEntities: [],
  warnings: [],
  changes: [],
  events: [],
};

describe('plugin-lifecycle', () => {
  beforeAll(() => {
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterAll(() => {
    jest.restoreAllMocks();
  });

  it('exports an NFS plugin, API, and Catalog entity-content extension', () => {
    expect(pluginLifecyclePlugin.$$type).toBe('@backstage/FrontendPlugin');
    expect(pluginLifecyclePlugin.pluginId).toBe('plugin-lifecycle');
    expect(pluginLifecycleApi).toBeDefined();
    expect(entityPluginLifecycleContent).toBeDefined();
  });

  it('attaches the lifecycle content to an NFS overlay workspace entity page', async () => {
    const api: PluginLifecycleApi = {
      getContext: jest.fn().mockResolvedValue(emptyContext),
      refreshContext: jest.fn().mockResolvedValue(emptyContext),
    };
    renderTestApp({
      features: [pluginLifecyclePlugin],
      extensions: [createTestEntityPage({ entity })],
      apis: [[pluginLifecycleApiRef, api]],
    });

    expect(
      await screen.findByText('No matching lifecycle evidence was found.'),
    ).toBeVisible();
  });

  it('filters the tab out for non-overlay entities', async () => {
    renderTestApp({
      features: [pluginLifecyclePlugin],
      extensions: [
        createTestEntityPage({
          entity: {
            ...entity,
            kind: 'Component',
            spec: { type: 'service' },
          },
        }),
      ],
    });

    expect(await screen.findByTestId('empty-entity-page')).toBeInTheDocument();
  });
});
