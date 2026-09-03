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
  configApiRef,
  createApiFactory,
  createComponentExtension,
  createPlugin,
  discoveryApiRef,
  fetchApiRef,
} from '@backstage/core-plugin-api';

import { PluginLifecycleClient, pluginLifecycleApiRef } from '../api';

/**
 * Legacy plugin instance for Plugin Lifecycle.
 *
 * The API implementation is shared with the NFS plugin so both frontend
 * systems call the same authenticated backend contract.
 *
 * @public
 */
export const pluginLifecyclePlugin = createPlugin({
  id: 'plugin-lifecycle',
  apis: [
    createApiFactory({
      api: pluginLifecycleApiRef,
      deps: {
        configApi: configApiRef,
        discoveryApi: discoveryApiRef,
        fetchApi: fetchApiRef,
      },
      factory: ({ discoveryApi, fetchApi }) =>
        new PluginLifecycleClient(discoveryApi, fetchApi),
    }),
  ],
});

/**
 * Lifecycle content extension for the legacy Catalog entity page.
 *
 * @public
 */
export const EntityPluginLifecycleContent = pluginLifecyclePlugin.provide(
  createComponentExtension({
    name: 'EntityPluginLifecycleContent',
    component: {
      lazy: () =>
        import('../components/EntityPluginLifecycleContent').then(
          m => m.EntityPluginLifecycleContent,
        ),
    },
  }),
);
