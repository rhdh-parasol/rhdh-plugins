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
import { createBackend } from '@backstage/backend-defaults';
import { mockServices } from '@backstage/backend-test-utils';
import { AuthorizeResult } from '@backstage/plugin-permission-common';
import { catalogServiceMock } from '@backstage/plugin-catalog-node/testUtils';

const backend = createBackend();

backend.add(mockServices.auth.factory());
backend.add(mockServices.httpAuth.factory());
backend.add(
  mockServices.permissions.factory({ result: AuthorizeResult.ALLOW }),
);
backend.add(
  catalogServiceMock.factory({
    entities: [
      {
        apiVersion: 'backstage.io/v1alpha1',
        kind: 'Component',
        metadata: {
          namespace: 'default',
          name: 'red-hat-developer-hub-global-header',
          title: 'Global Header source',
          description: 'Global Header source workspace',
        },
        spec: { type: 'library' },
      },
      {
        apiVersion: 'extensions.backstage.io/v1alpha1',
        kind: 'Plugin',
        metadata: {
          namespace: 'rhdh',
          name: 'global-header',
          title: 'Global Header',
          description: 'Shared application header for Red Hat Developer Hub',
        },
        spec: { lifecycle: 'active' },
      },
      {
        apiVersion: 'backstage.io/v1alpha1',
        kind: 'Component',
        metadata: {
          namespace: 'default',
          name: 'overlay-global-header',
          title: 'Overlay workspace global-header',
          annotations: {
            'github.com/project-slug':
              'rhdh-parasol/rhdh-plugin-export-overlays',
            'rhdh.io/overlay-workspace': 'global-header',
            'rhdh.io/source-entity-ref':
              'component:default/red-hat-developer-hub-global-header',
            'rhdh.io/extensions-plugin-refs': 'plugin:rhdh/global-header',
            'rhdh.io/extensions-package-refs':
              'package:rhdh/red-hat-developer-hub-backstage-plugin-global-header',
          },
        },
        spec: { type: 'rhdh-overlay-workspace' },
        relations: [
          {
            type: 'dependsOn',
            targetRef: 'component:default/red-hat-developer-hub-global-header',
          },
        ],
      },
      {
        apiVersion: 'backstage.io/v1alpha1',
        kind: 'Package',
        metadata: {
          namespace: 'rhdh',
          name: 'red-hat-developer-hub-backstage-plugin-global-header',
          title: '@red-hat-developer-hub/backstage-plugin-global-header',
        },
        spec: {
          packageName: '@red-hat-developer-hub/backstage-plugin-global-header',
          version: '2.0.0',
          backstage: { supportedVersions: ['1.52.0'] },
          support: { provider: 'Red Hat', level: 'GA' },
          dynamicArtifact:
            'oci://ghcr.io/rhdh/red-hat-developer-hub-backstage-plugin-global-header:2.0.0@sha256:58bf836bfcfb73e6866d3288db974218c059b226f6d4a8c6d776ac3b7df2f332',
        },
      },
      {
        apiVersion: 'extensions.backstage.io/v1alpha1',
        kind: 'Plugin',
        metadata: {
          namespace: 'rhdh',
          name: 'example-analytics',
          title: 'Example Analytics',
          description: 'Synthetic plugin used to prove generic lifecycle data',
        },
        spec: { lifecycle: 'experimental' },
      },
      {
        apiVersion: 'backstage.io/v1alpha1',
        kind: 'Component',
        metadata: {
          namespace: 'default',
          name: 'overlay-example-analytics',
          title: 'Overlay workspace bulk-import',
          annotations: {
            'github.com/project-slug':
              'rhdh-parasol/rhdh-plugin-export-overlays',
            'rhdh.io/overlay-workspace': 'example-analytics',
            'rhdh.io/extensions-plugin-refs': 'plugin:rhdh/example-analytics',
            'rhdh.io/extensions-package-refs':
              'package:default/example-analytics',
          },
        },
        spec: { type: 'rhdh-overlay-workspace' },
      },
      {
        apiVersion: 'extensions.backstage.io/v1alpha1',
        kind: 'Package',
        metadata: {
          namespace: 'default',
          name: 'example-analytics',
          title: '@acme/backstage-plugin-example-analytics',
        },
        spec: {
          packageName: '@acme/backstage-plugin-example-analytics',
          version: '1.4.0',
          backstage: { supportedVersions: ['1.54.4'] },
          support: { provider: 'Acme', level: 'community' },
        },
      },
    ],
  }),
);
backend.add(import('../src'));
backend.add(import('@backstage/plugin-mcp-actions-backend'));
backend.start();
