/*
 * Copyright Red Hat, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 */
import type { Entity } from '@backstage/catalog-model';
import type { BackstageCredentials } from '@backstage/backend-plugin-api';
import type { CatalogService } from '@backstage/plugin-catalog-node';
import type {
  CatalogEntitySummary,
  Delivery,
} from '@red-hat-developer-hub/backstage-plugin-lifecycle-common';
import type { LifecycleSyncState, StoredChange } from '../database/types';
import { deliveryCandidates } from './deliveryCandidates';
import { releasedPackages } from './deliveryPackages';
import { deliveryStatus } from './deliveryStatus';

export interface DeliveryDerivationInput {
  subject: CatalogEntitySummary;
  summaries: CatalogEntitySummary[];
  overlayEntity?: Entity;
  requestedEntity?: Entity;
  changes: StoredChange[];
  syncState: LifecycleSyncState;
  catalog: CatalogService;
  credentials: BackstageCredentials;
}

/**
 * Composes the three delivery read-model concerns: released packages,
 * in-flight candidates, and mainline status. Each helper is independently
 * testable while this function remains the single public entrypoint.
 */
export async function buildDelivery({
  subject,
  summaries,
  overlayEntity,
  requestedEntity,
  changes,
  syncState,
  catalog,
  credentials,
}: DeliveryDerivationInput): Promise<Delivery> {
  const released = await releasedPackages({
    summaries,
    requestedEntity,
    catalog,
    credentials,
  });
  const candidates = deliveryCandidates(changes);
  const status = deliveryStatus({
    candidates,
    changes,
    releasedPackages: released,
  });
  return {
    ...status,
    ownerRef:
      summaries.find(summary => summary.role === 'source')?.ownerRef ??
      subject.ownerRef,
    workspace:
      overlayEntity?.metadata.annotations?.['rhdh.io/overlay-workspace'] ??
      subject.name.replace(/^overlay-/, ''),
    releasedPackages: released,
    activeCandidates: candidates,
    freshness: {
      syncStatus: syncState.status,
      lastSuccessAt: syncState.lastSuccessAt,
      stale:
        !syncState.lastSuccessAt ||
        Date.now() - new Date(syncState.lastSuccessAt).getTime() > 60_000,
    },
  };
}
