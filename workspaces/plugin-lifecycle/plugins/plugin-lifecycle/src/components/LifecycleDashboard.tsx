/*
 * Copyright Red Hat, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 */
import { Alert, Button, Flex } from '@backstage/ui';
import type {
  LifecycleContext,
  LifecycleEvent,
} from '@red-hat-developer-hub/backstage-plugin-lifecycle-common';
import { RiHistoryLine, RiRefreshLine } from '@remixicon/react';
import type { LifecycleRefreshResult } from '../hooks/useLifecycleContext';
import { formattedTime } from '../utils/lifecyclePresentation';
import { DeliveryOverview } from './DeliveryOverview';
import { EmptyLifecycleEvidence } from './EmptyLifecycleEvidence';
import { EmptyPanel } from './EmptyPanel';
import { LifecycleEvidence } from './LifecycleEvidence';
import { MappingWarnings } from './MappingWarnings';

export function LifecycleDashboard({
  context,
  selectedChangeId,
  onChangeSelected,
  onViewAt,
  onReturnToCurrent,
  refreshError,
  refreshResult,
  loading = false,
  selectionLoading = false,
  onRetry,
  onRefresh,
}: {
  context: LifecycleContext;
  selectedChangeId?: string;
  onChangeSelected: (changeId: string) => void;
  onViewAt: (event: LifecycleEvent) => void;
  onReturnToCurrent: () => void;
  refreshError?: Error;
  refreshResult?: LifecycleRefreshResult;
  loading?: boolean;
  selectionLoading?: boolean;
  onRetry?: () => void;
  onRefresh?: () => void;
}) {
  const selectableChanges = context.changes.filter(
    change => change.scope !== 'branch',
  );
  const selectedChange =
    context.selectedChange?.scope === 'branch'
      ? undefined
      : context.selectedChange;
  const syncStatus = context.sync?.status;
  const collecting =
    syncStatus === 'pending' ||
    syncStatus === 'prioritized' ||
    syncStatus === 'running' ||
    (syncStatus === 'never' && context.sync?.bootstrapStatus === 'running');
  let refreshLabel = collecting
    ? 'Load this plugin now'
    : 'Refresh from GitHub';
  if (loading) refreshLabel = selectionLoading ? 'Loading…' : 'Refreshing…';
  const refreshAction =
    onRefresh &&
    !context.asOf &&
    !context.asOfEventId &&
    context.sync?.canRefresh !== false ? (
      <Button
        variant="primary"
        iconStart={<RiRefreshLine aria-hidden="true" />}
        isDisabled={loading}
        onPress={onRefresh}
      >
        {refreshLabel}
      </Button>
    ) : undefined;

  if (
    context.delivery &&
    (!selectedChange || !context.projection || selectableChanges.length === 0)
  ) {
    return (
      <Flex direction="column" gap="5">
        <MappingWarnings warnings={context.warnings} />
        <DeliveryOverview
          delivery={context.delivery}
          action={refreshAction}
          refreshResult={refreshResult}
        />
        <EmptyLifecycleEvidence
          sync={context.sync}
          refreshing={loading}
          refreshResult={refreshResult}
          onRefresh={onRefresh}
        />
      </Flex>
    );
  }
  if (!selectedChange || selectableChanges.length === 0) {
    return (
      <EmptyPanel
        title={
          syncStatus === 'never' || collecting
            ? 'Lifecycle data has not been loaded yet.'
            : 'No matching lifecycle evidence was found.'
        }
        description={
          context.sync?.canRefresh === false
            ? 'Synchronization is unavailable or your permissions are read-only.'
            : 'Refresh this plugin to collect the latest lifecycle evidence.'
        }
        action={refreshAction}
      />
    );
  }
  if (!context.projection) {
    return (
      <EmptyPanel
        title="No lifecycle state existed at this time"
        description="Choose a later point in the evidence timeline or return to the current state."
        action={
          context.asOf || context.asOfEventId ? (
            <Button variant="primary" onPress={onReturnToCurrent}>
              Return to current
            </Button>
          ) : undefined
        }
      />
    );
  }
  return (
    <Flex direction="column" gap="5">
      <MappingWarnings warnings={context.warnings} />
      {context.delivery && (
        <DeliveryOverview
          delivery={context.delivery}
          action={refreshAction}
          refreshResult={refreshResult}
        />
      )}
      {loading && (
        <Alert
          status="info"
          icon
          title={
            selectionLoading
              ? 'Loading the selected change'
              : 'Fetching fresh evidence from GitHub'
          }
          description={
            selectionLoading
              ? 'The stored evidence is loading. The current page remains visible.'
              : 'Checking workflow jobs, pull requests, and candidate images. Stored lifecycle evidence remains visible.'
          }
          aria-live="polite"
        />
      )}
      {refreshError && (
        <Alert
          status="danger"
          icon
          title="Live refresh failed"
          description={`${refreshError.message} Showing the last known lifecycle state.`}
          customActions={
            onRefresh ?? onRetry ? (
              <Button
                variant="secondary"
                size="small"
                onPress={onRefresh ?? onRetry}
              >
                Retry
              </Button>
            ) : undefined
          }
        />
      )}
      {context.sync?.canRefresh === false && context.sync.stale && (
        <Alert
          status="info"
          icon
          title="Read-only lifecycle context"
          description="You can view stored lifecycle evidence, but synchronization is unavailable or your permissions do not allow a live refresh."
        />
      )}
      {(context.sync?.status === 'failed' ||
        context.sync?.status === 'rate_limited') &&
        context.sync.errorSummary && (
          <Alert
            status="warning"
            icon
            title={
              context.sync.status === 'rate_limited'
                ? 'GitHub refresh is rate limited'
                : 'The last lifecycle refresh failed'
            }
            description="Showing the last known lifecycle state."
          />
        )}
      {context.subject.catalogStatus === 'missing' && (
        <Alert
          status="warning"
          icon
          title="Catalog entity missing"
          description="This plugin is no longer available in the Catalog. Its retained lifecycle history remains readable."
        />
      )}
      {(context.asOf || context.asOfEventId) && (
        <Alert
          status="info"
          icon={<RiHistoryLine aria-hidden="true" />}
          title={
            context.asOf
              ? `Showing state at ${formattedTime(context.asOf)}`
              : `Showing state at event cursor ${context.asOfEventId}`
          }
          description="Live updates are paused."
          customActions={
            <Button
              variant="secondary"
              size="small"
              iconStart={<RiRefreshLine aria-hidden="true" />}
              onPress={onReturnToCurrent}
            >
              Return to current
            </Button>
          }
        />
      )}
      <LifecycleEvidence
        context={context}
        selectedChangeId={selectedChangeId}
        onChangeSelected={onChangeSelected}
        onViewAt={onViewAt}
      />
    </Flex>
  );
}
