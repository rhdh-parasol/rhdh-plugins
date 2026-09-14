/*
 * Copyright Red Hat, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 */
import {
  Badge,
  Box,
  Card,
  CardBody,
  CardHeader,
  Flex,
  Link,
  Text,
} from '@backstage/ui';
import type { Delivery } from '@red-hat-developer-hub/backstage-plugin-lifecycle-common';
import { RiExternalLinkLine } from '@remixicon/react';
import type { ReactElement } from 'react';
import type { LifecycleRefreshResult } from '../hooks/useLifecycleContext';
import {
  deliveryStatusLabel,
  formattedTime,
  refreshResultSummary,
} from '../utils/lifecyclePresentation';
import { deliveryStatusIcon } from '../utils/lifecycleStatus';
import { DeliveryCandidates } from './DeliveryCandidates';
import { MainlineHealth } from './MainlineHealth';
import { ReleasedPackagesTable } from './ReleasedPackagesTable';
// @ts-ignore CSS modules are resolved by the Backstage webpack build.
import styles from './Delivery.module.css';
// @ts-ignore CSS modules are resolved by the Backstage webpack build.
import sharedStyles from './Shared.module.css';

export function DeliveryOverview({
  delivery,
  action,
  refreshResult,
}: {
  delivery: Delivery;
  action?: ReactElement;
  refreshResult?: LifecycleRefreshResult;
}) {
  const hasMainlineEvidence = Boolean(
    delivery.mainline.latestBuild || delivery.mainline.latestSuccessfulBuild,
  );
  return (
    <Card className={styles.deliveryCard}>
      <CardHeader className={styles.compactCardHeader}>
        <Flex
          direction={{ initial: 'column', md: 'row' }}
          justify="between"
          align={{ initial: 'start', md: 'center' }}
          gap="2"
        >
          <Flex direction="column" gap="1">
            <Text as="h2" variant="body-large" weight="bold">
              Current delivery
            </Text>
            <Flex gap="2" align="center" className={sharedStyles.actionRow}>
              <Badge
                className={styles.deliveryStatus}
                data-status={delivery.status}
                icon={deliveryStatusIcon(delivery.status)}
              >
                {deliveryStatusLabel(delivery.status)}
              </Badge>
              {delivery.freshness.lastSuccessAt && (
                <Text variant="body-x-small" color="secondary">
                  Updated {formattedTime(delivery.freshness.lastSuccessAt)}
                </Text>
              )}
              {refreshResult && (
                <Text
                  variant="body-x-small"
                  color="secondary"
                  aria-live="polite"
                >
                  GitHub refresh complete ·{' '}
                  {refreshResultSummary(refreshResult)}
                </Text>
              )}
            </Flex>
          </Flex>
          {action}
        </Flex>
      </CardHeader>
      <CardBody className={styles.compactCardBody}>
        <Flex direction="column" gap="3">
          {delivery.status !== 'stable' &&
            (delivery.status !== 'unknown' || delivery.nextAction) && (
              <Box
                className={styles.decisionPanel}
                data-status={delivery.status}
                role="status"
              >
                <Flex direction="column" gap="1">
                  <Text variant="body-small" weight="bold">
                    {delivery.statusReason}
                  </Text>
                  {delivery.nextAction && (
                    <Text variant="body-small">
                      Next: {delivery.nextAction}
                    </Text>
                  )}
                  {delivery.nextActionUrl && (
                    <Link
                      href={delivery.nextActionUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      variant="body-small"
                    >
                      {delivery.nextActionLabel ?? 'Open supporting evidence'}{' '}
                      <RiExternalLinkLine size={13} aria-hidden="true" />
                    </Link>
                  )}
                </Flex>
              </Box>
            )}
          <Box className={styles.deliveryLanes}>
            <Box className={styles.deliveryLane} data-lane="released">
              <Text as="h3" variant="body-large" weight="bold">
                Available in Extensions Catalog (
                {delivery.releasedPackages.length})
              </Text>
              {delivery.releasedPackages.length === 0 ? (
                <Text variant="body-small" color="secondary">
                  No available Package entity is currently mapped to this
                  workspace.
                </Text>
              ) : (
                <ReleasedPackagesTable packages={delivery.releasedPackages} />
              )}
            </Box>
            <DeliveryCandidates
              candidates={delivery.activeCandidates}
              wide={!hasMainlineEvidence}
            />
            <MainlineHealth
              mainline={delivery.mainline}
              wide={delivery.activeCandidates.length === 0}
            />
            {(delivery.activeCandidates.length === 0 ||
              !hasMainlineEvidence) && (
              <Flex
                className={styles.deliveryEmptySummary}
                align="center"
                gap="4"
              >
                <Text variant="body-small">
                  <strong>Open candidates:</strong>{' '}
                  {delivery.activeCandidates.length === 0
                    ? 'None'
                    : delivery.activeCandidates.length}
                </Text>
                {!hasMainlineEvidence && (
                  <Text variant="body-small" color="secondary">
                    <strong>Mainline:</strong> No build evidence collected
                  </Text>
                )}
              </Flex>
            )}
          </Box>
        </Flex>
      </CardBody>
    </Card>
  );
}
