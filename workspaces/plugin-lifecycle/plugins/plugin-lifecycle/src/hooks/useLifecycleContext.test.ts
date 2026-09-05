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
import { createElement, type ReactNode } from 'react';
import { TestApiProvider } from '@backstage/frontend-test-utils';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { PluginLifecycleApi } from '../api/PluginLifecycleApi';
import { pluginLifecycleApiRef } from '../api/PluginLifecycleApi';
import { useLifecycleContext } from './useLifecycleContext';
import type { LifecycleContext } from '@red-hat-developer-hub/backstage-plugin-lifecycle-common';

const context: LifecycleContext = {
  schemaVersion: 2,
  requestedEntityRef: 'component:default/overlay-example',
  subject: {
    entityRef: 'component:default/overlay-example',
    role: 'subject',
    catalogStatus: 'available',
    kind: 'Component',
    name: 'overlay-example',
    namespace: 'default',
    supportedVersions: [],
  },
  relatedEntities: [],
  warnings: [],
  changes: [],
  events: [],
};

describe('useLifecycleContext', () => {
  const getContext = jest.fn<
    ReturnType<PluginLifecycleApi['getContext']>,
    []
  >();
  const refreshContext = jest.fn<
    ReturnType<PluginLifecycleApi['refreshContext']>,
    [string]
  >();
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(TestApiProvider, {
      apis: [[pluginLifecycleApiRef, { getContext, refreshContext }]],
      children,
    });

  beforeEach(() => {
    jest.useFakeTimers();
    getContext.mockReset().mockResolvedValue(context);
    refreshContext.mockReset().mockResolvedValue(context);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('does not poll a ready current context', async () => {
    const { result } = renderHook(
      () =>
        useLifecycleContext({
          entityRef: 'component:default/overlay-example',
        }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(getContext).toHaveBeenCalledTimes(1);

    await act(async () => {
      jest.advanceTimersByTime(3_000);
      await Promise.resolve();
    });
    expect(getContext).toHaveBeenCalledTimes(1);
  });

  it('stops polling in historical mode and exposes request failures', async () => {
    getContext.mockRejectedValueOnce(new Error('backend unavailable'));
    const { result } = renderHook(
      () =>
        useLifecycleContext({
          entityRef: 'component:default/overlay-example',
          asOf: '2026-09-01T10:00:00.000Z',
        }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error?.message).toBe('backend unavailable');

    await act(async () => {
      jest.advanceTimersByTime(6_000);
      await Promise.resolve();
    });
    expect(getContext).toHaveBeenCalledTimes(1);
  });

  it('retains the last known state when a background refresh fails', async () => {
    const { result } = renderHook(
      () =>
        useLifecycleContext({
          entityRef: 'component:default/overlay-example',
        }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.data).toEqual(context));
    refreshContext.mockRejectedValueOnce(new Error('refresh failed'));

    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.data).toEqual(context);
    expect(result.current.error?.message).toBe('refresh failed');
  });

  it('reports when a GitHub refresh found no new evidence', async () => {
    const { result } = renderHook(
      () =>
        useLifecycleContext({
          entityRef: 'component:default/overlay-example',
        }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.data).toEqual(context));

    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.refreshResult).toEqual({
      changesAdded: 0,
      eventsAdded: 0,
    });
  });

  it('keeps the current page visible while a selected change is loading', async () => {
    let resolveSelection: (value: LifecycleContext) => void = () => {};
    const selection = new Promise<LifecycleContext>(resolve => {
      resolveSelection = resolve;
    });
    getContext
      .mockResolvedValueOnce(context)
      .mockReturnValueOnce(
        selection as ReturnType<PluginLifecycleApi['getContext']>,
      );
    const { result, rerender } = renderHook(
      ({ changeId }: { changeId?: string }) =>
        useLifecycleContext({
          entityRef: 'component:default/overlay-example',
          changeId,
        }),
      {
        wrapper,
        initialProps: { changeId: undefined as string | undefined },
      },
    );
    await waitFor(() => expect(result.current.data).toEqual(context));

    rerender({ changeId: '18163e4e-b0a5-431b-80f1-4913362d9926' });
    expect(result.current.loading).toBe(true);
    expect(result.current.data).toEqual(context);

    await act(async () => resolveSelection(context));
    await waitFor(() => expect(result.current.loading).toBe(false));
  });
});
