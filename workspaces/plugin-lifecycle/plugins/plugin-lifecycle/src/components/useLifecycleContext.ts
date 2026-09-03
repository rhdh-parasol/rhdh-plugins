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
import { useApi } from '@backstage/frontend-plugin-api';
import type { LifecycleContext } from '@red-hat-developer-hub/backstage-plugin-lifecycle-common';
import { useCallback, useEffect, useRef, useState } from 'react';
import { pluginLifecycleApiRef } from '../api/PluginLifecycleApi';

export interface LifecycleRefreshResult {
  changesAdded: number;
  eventsAdded: number;
}

function shouldPoll(data: LifecycleContext): boolean {
  return (
    !data.asOf &&
    !data.asOfEventId &&
    ['pending', 'prioritized', 'running'].includes(data.sync?.status ?? '')
  );
}

export function useLifecycleContext(options: {
  entityRef: string;
  changeId?: string;
  asOf?: string;
  asOfEventId?: string;
}) {
  const api = useApi(pluginLifecycleApiRef);
  const [reloadToken, setReloadToken] = useState(0);
  const refreshPollTimer = useRef<ReturnType<typeof setTimeout>>();
  const [state, setState] = useState<{
    loading: boolean;
    data?: LifecycleContext;
    error?: Error;
    refreshResult?: LifecycleRefreshResult;
  }>({ loading: true });

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async (background = false) => {
      if (!background) {
        // Keep the current context visible while a selected change or
        // historical cursor is loading. Clearing it makes a local selector
        // change look like a full page reload and hides useful context.
        setState(previous => ({
          ...previous,
          loading: true,
          error: undefined,
        }));
      }
      try {
        const data = await api.getContext({
          entityRef: options.entityRef,
          changeId: options.changeId,
          asOf: options.asOf,
          asOfEventId: options.asOfEventId,
          eventLimit: 500,
        });
        if (active) {
          setState(previous => ({
            loading: false,
            data,
            refreshResult: background ? previous.refreshResult : undefined,
          }));
          if (shouldPoll(data)) {
            timer = setTimeout(() => setReloadToken(value => value + 1), 3_000);
          }
        }
      } catch (error) {
        if (active) {
          setState(previous => ({
            ...previous,
            loading: false,
            error:
              error instanceof Error
                ? error
                : new Error('Plugin lifecycle context could not be loaded'),
          }));
        }
      }
    };

    void load(reloadToken > 0);
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
      if (refreshPollTimer.current) {
        clearTimeout(refreshPollTimer.current);
        refreshPollTimer.current = undefined;
      }
    };
  }, [
    api,
    options.asOf,
    options.asOfEventId,
    options.changeId,
    options.entityRef,
    reloadToken,
  ]);

  const reload = useCallback(() => setReloadToken(value => value + 1), []);
  const refresh = useCallback(async () => {
    const previousData = state.data;
    setState(previous => ({
      ...previous,
      loading: true,
      error: undefined,
      refreshResult: undefined,
    }));
    try {
      const data = await api.refreshContext(options.entityRef);
      const previousChangeIds = new Set(
        previousData?.changes.map(change => change.changeId) ?? [],
      );
      const previousEventIds = new Set(
        previousData?.events.map(event => event.eventId) ?? [],
      );
      setState({
        loading: false,
        data,
        refreshResult: {
          changesAdded: data.changes.filter(
            change => !previousChangeIds.has(change.changeId),
          ).length,
          eventsAdded: data.events.filter(
            event => !previousEventIds.has(event.eventId),
          ).length,
        },
      });
      if (shouldPoll(data)) {
        if (refreshPollTimer.current) clearTimeout(refreshPollTimer.current);
        refreshPollTimer.current = setTimeout(
          () => setReloadToken(value => value + 1),
          3_000,
        );
      }
    } catch (error) {
      setState(previous => ({
        ...previous,
        loading: false,
        error: error instanceof Error ? error : new Error('Refresh failed'),
      }));
    }
  }, [api, options.entityRef, state.data]);
  return { ...state, reload, refresh };
}
