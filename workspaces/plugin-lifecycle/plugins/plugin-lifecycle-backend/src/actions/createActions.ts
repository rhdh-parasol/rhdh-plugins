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
import type { ActionsRegistryService } from '@backstage/backend-plugin-api/alpha';
import {
  createChangeInputSchema,
  createChangeOutputSchema,
  getContextActionInputSchema,
  getContextOutputSchema,
  pluginLifecycleChangeCreatePermission,
  pluginLifecycleChangeReadPermission,
  pluginLifecycleEventCreatePermission,
  pluginLifecycleSyncRunPermission,
  recordEventInputSchema,
  recordEventOutputSchema,
  refreshInputSchema,
  refreshOutputSchema,
} from '@red-hat-developer-hub/backstage-plugin-lifecycle-common';
import type { LifecycleService } from '../service/LifecycleService';

export function createPluginLifecycleActions(options: {
  actionsRegistry: ActionsRegistryService;
  service: LifecycleService;
}): void {
  options.actionsRegistry.register({
    name: 'create-change',
    title: 'Create Plugin Lifecycle Change',
    description:
      'Creates an idempotent lifecycle change for an RHDH overlay workspace Component.',
    visibilityPermission: pluginLifecycleChangeCreatePermission,
    attributes: { destructive: false, idempotent: true, readOnly: false },
    schema: {
      input: () => createChangeInputSchema,
      output: () => createChangeOutputSchema,
    },
    action: async ({ input, credentials }) => ({
      output: await options.service.createChange(input, credentials),
    }),
  });

  options.actionsRegistry.register({
    name: 'record-event',
    title: 'Record Plugin Lifecycle Event',
    description:
      'Appends normalized CI, verification, artifact, reference, phase, or agent evidence to a lifecycle change.',
    visibilityPermission: pluginLifecycleEventCreatePermission,
    attributes: { destructive: false, idempotent: true, readOnly: false },
    schema: {
      input: () => recordEventInputSchema,
      output: () => recordEventOutputSchema,
    },
    action: async ({ input, credentials }) => ({
      output: await options.service.recordEvent(input, credentials),
    }),
  });

  options.actionsRegistry.register({
    name: 'get-context',
    title: 'Get Plugin Lifecycle Context',
    description:
      'Returns lifecycle state and provenance for a Catalog entity. Current stale data may be refreshed automatically; historical requests never refresh.',
    visibilityPermission: pluginLifecycleChangeReadPermission,
    attributes: { destructive: false, idempotent: false, readOnly: false },
    schema: {
      input: () => getContextActionInputSchema,
      output: () => getContextOutputSchema,
    },
    action: async ({ input, credentials }) => {
      let refreshAttempted = false;
      let refreshError: unknown;
      if (
        input.refreshPolicy === 'if_stale' &&
        !input.asOf &&
        !input.asOfEventId
      ) {
        try {
          const cached = await options.service.getContext(
            {
              entityRef: input.entityRef,
              changeId: input.changeId,
              eventLimit: input.eventLimit,
            },
            credentials,
          );
          if (
            cached.sync?.stale ||
            ['never', 'pending', 'prioritized', 'running'].includes(
              cached.sync?.status ?? '',
            )
          ) {
            await options.service.refresh(input.entityRef, credentials);
            refreshAttempted = true;
          }
        } catch (error) {
          refreshAttempted = true;
          refreshError = error;
          // A caller may have read permission without synchronization permission;
          // in that case return the durable cached context and explain why it
          // could not be refreshed.
        }
      }
      const { refreshPolicy, ...contextInput } = input;
      void refreshPolicy;
      const output = await options.service.getContext(
        contextInput,
        credentials,
      );
      if (refreshAttempted && output.sync) {
        output.sync.refreshAttempted = true;
        if (refreshError && !output.sync.errorSummary) {
          output.sync.errorSummary =
            refreshError instanceof Error
              ? refreshError.message
              : String(refreshError);
        }
      }
      return { output };
    },
  });

  options.actionsRegistry.register({
    name: 'refresh',
    title: 'Refresh Plugin Lifecycle Context',
    description:
      'Explicitly synchronizes one Catalog plugin lifecycle subject from configured evidence sources.',
    visibilityPermission: pluginLifecycleSyncRunPermission,
    attributes: { destructive: false, idempotent: false, readOnly: false },
    schema: {
      input: () => refreshInputSchema,
      output: () => refreshOutputSchema,
    },
    action: async ({ input, credentials }) => ({
      output: await options.service.refresh(input.entityRef, credentials),
    }),
  });
}
