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
import {
  createApiRef,
  type DiscoveryApi,
  type FetchApi,
} from '@backstage/frontend-plugin-api';
import { ResponseError } from '@backstage/errors';
import {
  type LifecycleContext,
  getContextOutputSchema,
} from '@red-hat-developer-hub/backstage-plugin-lifecycle-common';

export interface GetLifecycleContextOptions {
  entityRef: string;
  changeId?: string;
  asOf?: string;
  asOfEventId?: string;
  eventLimit?: number;
}

export interface PluginLifecycleApi {
  getContext(options: GetLifecycleContextOptions): Promise<LifecycleContext>;
  refreshContext(entityRef: string): Promise<LifecycleContext>;
}

export const pluginLifecycleApiRef = createApiRef<PluginLifecycleApi>().with({
  // Namespace the ref because NFS and Legacy modules share one runtime and
  // generic ids can collide with another dynamic plugin.
  id: 'plugin-lifecycle.service',
  pluginId: 'plugin-lifecycle',
});

export class PluginLifecycleClient implements PluginLifecycleApi {
  constructor(
    private readonly discoveryApi: DiscoveryApi,
    private readonly fetchApi: FetchApi,
  ) {}

  async getContext(
    options: GetLifecycleContextOptions,
  ): Promise<LifecycleContext> {
    const baseUrl = await this.discoveryApi.getBaseUrl('plugin-lifecycle');
    const query = new URLSearchParams();
    query.set('entityRef', options.entityRef);
    if (options.changeId) query.set('changeId', options.changeId);
    if (options.asOf) query.set('asOf', options.asOf);
    if (options.asOfEventId) query.set('asOfEventId', options.asOfEventId);
    if (options.eventLimit) query.set('eventLimit', String(options.eventLimit));
    const response = await this.fetchApi.fetch(`${baseUrl}/context?${query}`);
    if (!response.ok) {
      throw await ResponseError.fromResponse(response);
    }
    return getContextOutputSchema.parse(await response.json());
  }

  async refreshContext(entityRef: string): Promise<LifecycleContext> {
    const baseUrl = await this.discoveryApi.getBaseUrl('plugin-lifecycle');
    const response = await this.fetchApi.fetch(`${baseUrl}/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entityRef }),
    });
    if (!response.ok) throw await ResponseError.fromResponse(response);
    return getContextOutputSchema.parse(await response.json());
  }
}
