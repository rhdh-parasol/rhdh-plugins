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
  ApiBlueprint,
  createFrontendPlugin,
  discoveryApiRef,
  fetchApiRef,
} from '@backstage/frontend-plugin-api';
import { EntityContentBlueprint } from '@backstage/plugin-catalog-react/alpha';
import {
  PluginLifecycleClient,
  pluginLifecycleApiRef,
} from './api/PluginLifecycleApi';
import { isLifecycleEntity } from './lifecycleEntity';

/** @public */
export const pluginLifecycleApi = ApiBlueprint.make({
  name: 'service',
  params: defineParams =>
    defineParams({
      api: pluginLifecycleApiRef,
      deps: { discoveryApi: discoveryApiRef, fetchApi: fetchApiRef },
      factory: ({ discoveryApi, fetchApi }) =>
        new PluginLifecycleClient(discoveryApi, fetchApi),
    }),
});

/** @public */
export const entityPluginLifecycleContent = EntityContentBlueprint.make({
  name: 'lifecycle',
  params: {
    path: '/lifecycle',
    title: 'Lifecycle',
    filter: entity => isLifecycleEntity(entity),
    loader: () =>
      import('./components/EntityPluginLifecycleContent').then(module => (
        <module.EntityPluginLifecycleContent />
      )),
  },
});

/** @public */
export const pluginLifecyclePlugin = createFrontendPlugin({
  pluginId: 'plugin-lifecycle',
  extensions: [pluginLifecycleApi, entityPluginLifecycleContent],
});
