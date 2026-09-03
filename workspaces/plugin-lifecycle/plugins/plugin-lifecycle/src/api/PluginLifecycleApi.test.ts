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
import type { DiscoveryApi, FetchApi } from '@backstage/frontend-plugin-api';
import { PluginLifecycleClient } from './PluginLifecycleApi';

const responseBody = {
  schemaVersion: 2,
  requestedEntityRef: 'component:rhdh/overlay-global-header',
  subject: {
    entityRef: 'component:rhdh/overlay-global-header',
    role: 'subject',
    catalogStatus: 'available',
    kind: 'Component',
    name: 'overlay-global-header',
    namespace: 'rhdh',
    supportedVersions: [],
  },
  relatedEntities: [],
  warnings: [],
  changes: [],
  events: [],
};

describe('PluginLifecycleClient', () => {
  const discoveryApi = {
    getBaseUrl: jest
      .fn()
      .mockResolvedValue('http://localhost:7007/api/plugin-lifecycle'),
  } as unknown as DiscoveryApi;
  const fetch = jest.fn();
  const fetchApi = { fetch } as unknown as FetchApi;

  beforeEach(() => fetch.mockReset());

  it('queries the authenticated RHDH endpoint and validates its output', async () => {
    fetch.mockResolvedValue(
      new Response(JSON.stringify(responseBody), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const client = new PluginLifecycleClient(discoveryApi, fetchApi);

    await expect(
      client.getContext({
        entityRef: 'component:default/overlay-global-header',
        changeId: '18163e4e-b0a5-431b-80f1-4913362d9926',
        asOf: '2026-09-01T10:00:00.000Z',
        eventLimit: 50,
      }),
    ).resolves.toEqual(responseBody);
    expect(fetch).toHaveBeenCalledWith(
      'http://localhost:7007/api/plugin-lifecycle/context?entityRef=component%3Adefault%2Foverlay-global-header&changeId=18163e4e-b0a5-431b-80f1-4913362d9926&asOf=2026-09-01T10%3A00%3A00.000Z&eventLimit=50',
    );
  });

  it('passes generic Catalog entity references through to the backend', async () => {
    const client = new PluginLifecycleClient(discoveryApi, fetchApi);
    fetch.mockResolvedValue(
      new Response(JSON.stringify(responseBody), { status: 200 }),
    );
    await expect(
      client.getContext({ entityRef: 'component:default/example' }),
    ).resolves.toEqual(responseBody);
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining('entityRef=component%3Adefault%2Fexample'),
    );
  });

  it('supports exact event cursors for historical reads', async () => {
    const client = new PluginLifecycleClient(discoveryApi, fetchApi);
    fetch.mockResolvedValue(
      new Response(JSON.stringify(responseBody), { status: 200 }),
    );
    await client.getContext({
      entityRef: 'component:default/overlay-global-header',
      asOfEventId: '17',
    });
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining('asOfEventId=17'),
    );
  });

  it('rejects a response that does not satisfy the shared contract', async () => {
    fetch.mockResolvedValue(
      new Response(JSON.stringify({ ...responseBody, schemaVersion: 1 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const client = new PluginLifecycleClient(discoveryApi, fetchApi);
    await expect(
      client.getContext({
        entityRef: 'component:default/overlay-global-header',
      }),
    ).rejects.toThrow();
  });
});
