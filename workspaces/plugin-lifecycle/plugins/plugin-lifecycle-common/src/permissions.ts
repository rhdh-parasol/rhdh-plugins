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
import { createPermission } from '@backstage/plugin-permission-common';

export const pluginLifecycleChangeReadPermission = createPermission({
  name: 'plugin-lifecycle.change.read',
  attributes: { action: 'read' },
});

export const pluginLifecycleChangeCreatePermission = createPermission({
  name: 'plugin-lifecycle.change.create',
  attributes: { action: 'create' },
});

export const pluginLifecycleEventCreatePermission = createPermission({
  name: 'plugin-lifecycle.event.create',
  attributes: { action: 'create' },
});

export const pluginLifecycleSyncRunPermission = createPermission({
  name: 'plugin-lifecycle.sync.run',
  attributes: { action: 'create' },
});

export const pluginLifecyclePermissions = [
  pluginLifecycleChangeReadPermission,
  pluginLifecycleChangeCreatePermission,
  pluginLifecycleEventCreatePermission,
  pluginLifecycleSyncRunPermission,
];
