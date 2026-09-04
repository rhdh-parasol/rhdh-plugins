/*
 * Copyright Red Hat, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 */
import { stringifyEntityRef } from '@backstage/catalog-model';
import { useEntity } from '@backstage/plugin-catalog-react';
import { Alert, Button } from '@backstage/ui';
import type { LifecycleEvent } from '@red-hat-developer-hub/backstage-plugin-lifecycle-common';
import { useCallback, useEffect, useState } from 'react';
import { useLifecycleContext } from '../hooks/useLifecycleContext';
import { isLifecycleEntity } from '../utils/isLifecycleEntity';
import { EmptyPanel } from './EmptyPanel';
import { LifecycleDashboard } from './LifecycleDashboard';
import { LoadingPanel } from './LoadingPanel';

export function EntityPluginLifecycleContent() {
  const { entity } = useEntity();
  const entityRef = stringifyEntityRef(entity);
  const [selectedChangeId, setSelectedChangeId] = useState<string>();
  const [asOf, setAsOf] = useState<string>();
  const [asOfEventId, setAsOfEventId] = useState<string>();
  const { data, loading, error, reload, refresh, refreshResult } =
    useLifecycleContext({
      entityRef,
      changeId: selectedChangeId,
      asOf,
      asOfEventId,
    });
  const selectionLoading = Boolean(
    loading &&
      data &&
      selectedChangeId &&
      selectedChangeId !== data.selectedChange?.changeId,
  );
  const handleChangeSelected = useCallback((changeId: string) => {
    setSelectedChangeId(changeId);
    setAsOf(undefined);
    setAsOfEventId(undefined);
  }, []);
  const handleViewAt = useCallback((event: LifecycleEvent) => {
    if (event.eventCursor) {
      setAsOf(undefined);
      setAsOfEventId(event.eventCursor);
    } else {
      setAsOf(event.occurredAt);
      setAsOfEventId(undefined);
    }
  }, []);
  const handleReturnToCurrent = useCallback(() => {
    setAsOf(undefined);
    setAsOfEventId(undefined);
  }, []);
  const handleRefresh = useCallback(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!data) return;
    const selectableChanges = data.changes.filter(
      change => change.scope !== 'branch',
    );
    if (
      selectedChangeId &&
      !selectableChanges.some(change => change.changeId === selectedChangeId)
    ) {
      setSelectedChangeId(selectableChanges[0]?.changeId);
      setAsOf(undefined);
      setAsOfEventId(undefined);
    } else if (
      !selectedChangeId &&
      data.selectedChange &&
      data.selectedChange.scope !== 'branch'
    ) {
      setSelectedChangeId(data.selectedChange.changeId);
    }
  }, [data, selectedChangeId]);

  if (!isLifecycleEntity(entity))
    return (
      <EmptyPanel
        title="Plugin lifecycle is unavailable"
        description="This view is available for mapped source and overlay Components."
      />
    );
  if (loading && !data) return <LoadingPanel />;
  if (error && !data)
    return (
      <Alert
        status="danger"
        icon
        title="Plugin lifecycle could not be loaded"
        description={error.message}
        customActions={
          <Button variant="secondary" size="small" onPress={reload}>
            Retry
          </Button>
        }
      />
    );
  if (!data) return <LoadingPanel />;

  return (
    <LifecycleDashboard
      context={data}
      selectedChangeId={selectedChangeId}
      onChangeSelected={handleChangeSelected}
      onViewAt={handleViewAt}
      onReturnToCurrent={handleReturnToCurrent}
      refreshError={error}
      refreshResult={refreshResult}
      loading={loading}
      selectionLoading={selectionLoading}
      onRetry={reload}
      onRefresh={handleRefresh}
    />
  );
}
