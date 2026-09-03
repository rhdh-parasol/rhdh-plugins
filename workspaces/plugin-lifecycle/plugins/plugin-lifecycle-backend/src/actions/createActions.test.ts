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
import { actionsRegistryServiceMock } from '@backstage/backend-test-utils/alpha';
import {
  pluginLifecycleChangeCreatePermission,
  pluginLifecycleChangeReadPermission,
  pluginLifecycleEventCreatePermission,
  pluginLifecycleSyncRunPermission,
} from '@red-hat-developer-hub/backstage-plugin-lifecycle-common';
import type { LifecycleService } from '../service/LifecycleService';
import { testContext, testCreateOutput, testCreatedEvent } from '../testData';
import { createPluginLifecycleActions } from './createActions';

describe('Plugin Lifecycle actions', () => {
  it('registers and invokes create, record, and context actions', async () => {
    const actionsRegistry = actionsRegistryServiceMock();
    const registerSpy = jest.spyOn(actionsRegistry, 'register');
    const service = {
      createChange: jest.fn().mockResolvedValue(testCreateOutput),
      recordEvent: jest.fn().mockResolvedValue({
        event: testCreatedEvent,
        projection: testCreateOutput.projection,
      }),
      getContext: jest.fn().mockResolvedValue(testContext),
    } as unknown as jest.Mocked<LifecycleService>;
    createPluginLifecycleActions({ actionsRegistry, service });

    await actionsRegistry.invoke({
      id: 'test:create-change',
      input: {
        requestId: 'request-1',
        subjectEntityRef: 'plugin:default/example',
        title: 'Upgrade plugin',
      },
    });
    await actionsRegistry.invoke({
      id: 'test:record-event',
      input: {
        eventId: 'event-1',
        changeId: testCreateOutput.change.changeId,
        occurredAt: testCreatedEvent.occurredAt,
        producer: 'test',
        event: {
          kind: 'phase.updated',
          phase: 'build',
          state: 'running',
          summary: 'Building',
        },
      },
    });
    await actionsRegistry.invoke({
      id: 'test:get-context',
      input: { entityRef: 'component:default/overlay-example' },
    });

    expect(service.createChange).toHaveBeenCalledTimes(1);
    expect(service.recordEvent).toHaveBeenCalledTimes(1);
    expect(service.getContext).toHaveBeenCalledTimes(2);

    const { actions } = await actionsRegistry.list();
    expect(actions.map(action => action.name)).toEqual([
      'create-change',
      'record-event',
      'get-context',
      'refresh',
    ]);
    expect(
      registerSpy.mock.calls.map(([action]) => [
        action.name,
        action.visibilityPermission?.name,
      ]),
    ).toEqual([
      ['create-change', pluginLifecycleChangeCreatePermission.name],
      ['record-event', pluginLifecycleEventCreatePermission.name],
      ['get-context', pluginLifecycleChangeReadPermission.name],
      ['refresh', pluginLifecycleSyncRunPermission.name],
    ]);
  });

  it('rejects input that does not satisfy the public action contract', async () => {
    const actionsRegistry = actionsRegistryServiceMock();
    const service = {} as LifecycleService;
    createPluginLifecycleActions({ actionsRegistry, service });

    await expect(
      actionsRegistry.invoke({
        id: 'test:create-change',
        input: {
          requestId: 'missing-title',
          subjectEntityRef: 'plugin:default/example',
        },
      }),
    ).rejects.toThrow();
  });

  it('prioritizes a subject that is still being collected', async () => {
    const actionsRegistry = actionsRegistryServiceMock();
    const service = {
      getContext: jest
        .fn()
        .mockResolvedValueOnce({
          ...testContext,
          sync: { status: 'pending', stale: false },
        })
        .mockResolvedValueOnce(testContext),
      refresh: jest.fn().mockResolvedValue(testContext),
    } as unknown as jest.Mocked<LifecycleService>;
    createPluginLifecycleActions({ actionsRegistry, service });

    await actionsRegistry.invoke({
      id: 'test:get-context',
      input: {
        entityRef: 'component:default/overlay-example',
        refreshPolicy: 'if_stale',
      },
    });

    expect(service.refresh).toHaveBeenCalledWith(
      'component:default/overlay-example',
      expect.anything(),
    );
    expect(service.getContext).toHaveBeenCalledTimes(2);
  });
});
