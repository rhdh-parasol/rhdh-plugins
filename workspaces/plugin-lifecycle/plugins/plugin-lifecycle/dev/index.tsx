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
import { createDevApp } from '@backstage/frontend-dev-utils';
import { createFrontendPlugin } from '@backstage/frontend-plugin-api';
import { createTestEntityPage } from '@backstage/plugin-catalog-react/testUtils';
import pluginLifecyclePlugin from '../src';

const entity = {
  apiVersion: 'backstage.io/v1alpha1',
  kind: 'Component',
  metadata: {
    namespace: 'default',
    name: 'overlay-global-header',
    title: 'Overlay workspace global-header',
    annotations: {
      'rhdh.io/overlay-workspace': 'global-header',
    },
  },
  spec: { type: 'rhdh-overlay-workspace' },
};

const devCatalogPlugin = createFrontendPlugin({
  pluginId: 'catalog',
  extensions: [createTestEntityPage({ entity })],
});

createDevApp({ features: [devCatalogPlugin, pluginLifecyclePlugin] });
