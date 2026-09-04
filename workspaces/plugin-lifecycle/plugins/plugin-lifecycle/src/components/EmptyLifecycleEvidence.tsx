/* Copyright Red Hat, Inc. */
import { Badge, Button, Card, CardBody, Flex, Text } from '@backstage/ui';
import type { LifecycleContext } from '@red-hat-developer-hub/backstage-plugin-lifecycle-common';
import { RiLoader4Line, RiRefreshLine } from '@remixicon/react';
import type { LifecycleRefreshResult } from '../hooks/useLifecycleContext';
// @ts-ignore CSS modules are resolved by the Backstage webpack build.
import styles from './LifecycleEvidence.module.css';
// @ts-ignore CSS modules are resolved by the Backstage webpack build.
import sharedStyles from './Shared.module.css';

function refreshResultMessage(result: LifecycleRefreshResult): string {
  if (result.eventsAdded > 0)
    return `Stored ${result.eventsAdded} new lifecycle event${
      result.eventsAdded === 1 ? '' : 's'
    } from GitHub.`;
  if (result.changesAdded > 0)
    return `Found ${result.changesAdded} new lifecycle change${
      result.changesAdded === 1 ? '' : 's'
    } on GitHub.`;
  return 'GitHub was checked successfully; no new matching evidence was found.';
}

export function EmptyLifecycleEvidence({
  sync,
  refreshing,
  refreshResult,
  onRefresh,
}: {
  sync: LifecycleContext['sync'];
  refreshing: boolean;
  refreshResult?: LifecycleRefreshResult;
  onRefresh?: () => void;
}) {
  let label = 'Not loaded';
  let message = 'Lifecycle data has not been loaded from GitHub yet.';
  let active = false;
  if (refreshing) {
    label = 'Fetching GitHub';
    message =
      'Checking workflow jobs, pull requests, and candidate image evidence.';
    active = true;
  } else if (refreshResult) {
    label = 'Refresh complete';
    message = refreshResultMessage(refreshResult);
  } else if (
    sync?.status === 'pending' ||
    sync?.bootstrapStatus === 'running'
  ) {
    label = 'Queued';
    message = 'Waiting in the initial GitHub collection queue.';
    active = true;
  } else if (sync?.status === 'prioritized' || sync?.status === 'running') {
    label = sync.status === 'prioritized' ? 'Next' : 'Fetching GitHub';
    message =
      sync.status === 'prioritized'
        ? 'This plugin has been prioritized and will be collected next.'
        : 'Checking workflow jobs, pull requests, and candidate image evidence.';
    active = true;
  } else if (sync?.status === 'empty' || sync?.status === 'succeeded') {
    label = 'Refresh complete';
    message =
      sync.status === 'empty'
        ? 'The last GitHub refresh found no matching lifecycle evidence.'
        : 'GitHub was checked successfully; no lifecycle events were added.';
  } else if (sync?.status === 'failed') {
    label = 'Refresh failed';
    message =
      sync.errorSummary ?? 'GitHub lifecycle evidence could not be refreshed.';
  } else if (sync?.status === 'rate_limited') {
    label = 'Rate limited';
    message = 'GitHub temporarily limited lifecycle collection.';
  }
  let refreshLabel = 'Refresh from GitHub';
  if (active) refreshLabel = 'Load this plugin now';
  if (refreshing) refreshLabel = 'Refreshing…';
  return (
    <Card>
      <CardBody className={styles.compactEvidenceEmpty} aria-live="polite">
        <Flex
          direction={{ initial: 'column', sm: 'row' }}
          align={{ initial: 'start', sm: 'center' }}
          justify="between"
          gap="1"
        >
          <Text as="h2" variant="body-large" weight="bold">
            Lifecycle evidence
          </Text>
          <Flex align="center" gap="2" className={sharedStyles.actionRow}>
            <Badge
              icon={active ? <RiLoader4Line aria-hidden="true" /> : undefined}
            >
              {label}
            </Badge>
            <Text variant="body-small" color="secondary">
              {message}
            </Text>
            {onRefresh && sync?.canRefresh !== false && (
              <Button
                variant="secondary"
                size="small"
                iconStart={<RiRefreshLine aria-hidden="true" />}
                isDisabled={refreshing}
                onPress={onRefresh}
              >
                {refreshLabel}
              </Button>
            )}
          </Flex>
        </Flex>
      </CardBody>
    </Card>
  );
}
