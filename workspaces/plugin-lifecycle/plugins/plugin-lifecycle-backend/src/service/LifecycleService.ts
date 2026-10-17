/*
 * Copyright Red Hat, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 */
import type {
  BackstageCredentials,
  PermissionsService,
} from '@backstage/backend-plugin-api';
import { stringifyEntityRef, type Entity } from '@backstage/catalog-model';
import { InputError } from '@backstage/errors';
import type { CatalogService } from '@backstage/plugin-catalog-node';
import {
  type CreateChangeInput,
  type CreateChangeOutput,
  type GetContextInput,
  type LifecycleContext,
  type RecordEventInput,
  type RecordEventOutput,
  createChangeInputSchema,
  pluginLifecycleChangeCreatePermission,
  pluginLifecycleEventCreatePermission,
  pluginLifecycleSyncRunPermission,
  recordEventInputSchema,
} from '@red-hat-developer-hub/backstage-plugin-lifecycle-common';
import { queryAllCatalogEntities } from '../catalogQuery';
import { LifecycleStore } from '../database/LifecycleStore';
import type {
  ChangeAssociation,
  CreateChangeOptions,
  LifecycleSubject,
  LifecycleSyncState,
  StoredChange,
} from '../database/types';
import { requirePermission } from './authorization';
import {
  isOverlayComponent,
  reconcileOverlay,
  requireOverlayEntity,
  resolveAssociations,
} from './catalogResolution';
import { buildLifecycleContext } from './contextBuilder';
import { actorRef, canonicalEntityRef, requireHumanIdentity } from './identity';

/** Maximum time a refresh request waits for the first persisted result. */
export const DEFAULT_REFRESH_WAIT_TIMEOUT_MS = 30_000;
export const MAX_REFRESH_WAIT_TIMEOUT_MS = 60_000;

/**
 * Application service for the Plugin Lifecycle backend.
 *
 * This class is intentionally a small facade. Catalog resolution and context
 * assembly live in dedicated modules so REST, Actions, and MCP all share the
 * same policy and read model.
 */
/** @public */
export class LifecycleService {
  private refresher?: (entityRef: string) => Promise<void>;
  private bootstrapKey?: string;

  constructor(
    private readonly store: LifecycleStore,
    private readonly catalog: CatalogService,
    private readonly permissions: PermissionsService,
    private readonly refreshWaitTimeoutMs = DEFAULT_REFRESH_WAIT_TIMEOUT_MS,
  ) {}

  setRefresher(refresher: (entityRef: string) => Promise<void>): void {
    this.refresher = refresher;
  }

  setBootstrapKey(bootstrapKey: string): void {
    this.bootstrapKey = bootstrapKey;
  }

  async updateSyncState(
    entityRef: string,
    state: LifecycleSyncState,
  ): Promise<void> {
    const subject = await this.store.getSubjectByEntity(
      canonicalEntityRef(entityRef),
    );
    if (subject) await this.store.setSyncState(subject.id, state);
  }

  async getSyncStateForEntity(entityRef: string): Promise<LifecycleSyncState> {
    const subject = await this.store.getSubjectByEntity(
      canonicalEntityRef(entityRef),
    );
    return subject ? this.store.getSyncState(subject.id) : { status: 'never' };
  }

  async createChange(
    rawInput: CreateChangeInput,
    credentials: BackstageCredentials,
  ): Promise<CreateChangeOutput> {
    requireHumanIdentity(credentials);
    const input = createChangeInputSchema.parse(rawInput);
    const subjectEntityRef = canonicalEntityRef(input.subjectEntityRef);
    await requirePermission(
      this.permissions,
      credentials,
      pluginLifecycleChangeCreatePermission,
      'Plugin Lifecycle change creation permission is required',
    );
    const entity = await this.catalog.getEntityByRef(subjectEntityRef, {
      credentials,
    });
    requireOverlayEntity(subjectEntityRef, entity);
    const associations = await this.associationsForWrite(entity, credentials);
    const stored = await this.store.createChange(
      { ...input, subjectEntityRef },
      actorRef(credentials),
      { associations, origin: 'action' },
    );
    return { change: stored.summary, projection: stored.projection };
  }

  async createSystemChange(
    rawInput: CreateChangeInput,
    options: CreateChangeOptions & { associations: ChangeAssociation[] },
  ): Promise<CreateChangeOutput> {
    const input = createChangeInputSchema.parse(rawInput);
    const subjectEntityRef = canonicalEntityRef(input.subjectEntityRef);
    const stored = await this.store.createChange(
      { ...input, subjectEntityRef },
      'system:plugin-lifecycle',
      options,
    );
    return { change: stored.summary, projection: stored.projection };
  }

  async recordEvent(
    rawInput: RecordEventInput,
    credentials: BackstageCredentials,
  ): Promise<RecordEventOutput> {
    requireHumanIdentity(credentials);
    const input = recordEventInputSchema.parse(rawInput);
    await requirePermission(
      this.permissions,
      credentials,
      pluginLifecycleEventCreatePermission,
      'Plugin Lifecycle event creation permission is required',
    );
    return this.store.appendEvent(input, actorRef(credentials));
  }

  async recordSystemEvent(input: RecordEventInput): Promise<RecordEventOutput> {
    return this.store.appendEvent(input, 'system:plugin-lifecycle');
  }

  async updateSystemChangeStatus(
    changeId: string,
    externalStatus: 'open' | 'merged' | 'closed' | 'published',
  ): Promise<void> {
    await this.store.updateExternalStatus(changeId, externalStatus);
  }

  async getChangeDetails(entityRef: string): Promise<StoredChange[]> {
    return this.store.getChangeDetails(entityRef);
  }

  async getSubjectForEntity(
    entityRef: string,
  ): Promise<LifecycleSubject | undefined> {
    return this.store.getSubjectByEntity(canonicalEntityRef(entityRef));
  }

  async associationsForEntity(entity: Entity): Promise<ChangeAssociation[]> {
    requireOverlayEntity(stringifyEntityRef(entity), entity);
    return resolveAssociations(entity);
  }

  /** Reconciles Catalog mappings without contacting GitHub. */
  async reconcileCatalog(credentials: BackstageCredentials): Promise<number> {
    const entities = await queryAllCatalogEntities(
      this.catalog,
      { filter: [{ kind: 'Component' }], limit: 500 },
      credentials,
    );
    const overlays = entities.filter(isOverlayComponent);
    for (const overlay of overlays) {
      await reconcileOverlay(overlay, this.catalog, this.store, credentials);
    }
    return overlays.length;
  }

  /** Revalidates one subject before an on-demand refresh. */
  async reconcileSubject(
    overlay: Entity,
    credentials: BackstageCredentials,
  ): Promise<void> {
    requireOverlayEntity(stringifyEntityRef(overlay), overlay);
    await reconcileOverlay(overlay, this.catalog, this.store, credentials);
  }

  /**
   * Starts a subject refresh and returns the latest durable snapshot after a
   * bounded wait. Long GitHub work continues in the collector and is visible
   * through persisted synchronization state.
   */
  async refresh(
    entityRef: string,
    credentials: BackstageCredentials,
  ): Promise<LifecycleContext> {
    requireHumanIdentity(credentials);
    await requirePermission(
      this.permissions,
      credentials,
      pluginLifecycleSyncRunPermission,
      'Plugin Lifecycle synchronization permission is required',
    );
    if (!this.refresher) {
      throw new InputError(
        'Plugin Lifecycle synchronization is not configured on this backend',
      );
    }

    const refreshPromise = this.refresher(canonicalEntityRef(entityRef));
    refreshPromise.catch(() => undefined);
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    let refreshError: unknown;
    const timeoutPromise = new Promise<void>(resolve => {
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        resolve();
      }, Math.max(1_000, this.refreshWaitTimeoutMs));
    });
    try {
      await Promise.race([refreshPromise, timeoutPromise]);
    } catch (error) {
      // Refresh failures are synchronization state, not read failures. Keep
      // the REST and action contracts useful by returning the last durable
      // context below with the error attached to its sync section.
      refreshError = error;
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
    }

    const context = await this.getContext(
      { entityRef, eventLimit: 100 },
      credentials,
    );
    if (context.sync) {
      context.sync.refreshAttempted = true;
      if (timedOut && !context.sync.errorSummary) {
        context.sync.errorSummary =
          'GitHub refresh is still running; showing the latest persisted context.';
      }
      if (refreshError && !context.sync.errorSummary) {
        context.sync.errorSummary =
          refreshError instanceof Error
            ? refreshError.message
            : String(refreshError);
      }
    }
    return context;
  }

  async recordSystemDiagnostic(input: {
    source: string;
    subjectEntityRef?: string;
    externalId?: string;
    reasonCode: string;
    summary: string;
    details: Record<string, unknown>;
  }): Promise<void> {
    await this.store.recordDiagnostic(input);
  }

  private async associationsForWrite(
    entity: Entity,
    credentials: BackstageCredentials,
  ): Promise<ChangeAssociation[]> {
    const associations = await this.associationsForEntity(entity);
    await Promise.all(
      associations
        .filter(association => association.role !== 'subject')
        .map(association =>
          this.catalog.getEntityByRef(association.entityRef, { credentials }),
        ),
    );
    return associations;
  }

  async getContext(
    rawInput: GetContextInput,
    credentials: BackstageCredentials,
  ): Promise<LifecycleContext> {
    return buildLifecycleContext(rawInput, credentials, {
      store: this.store,
      catalog: this.catalog,
      permissions: this.permissions,
      bootstrapKey: this.bootstrapKey,
      refresherConfigured: Boolean(this.refresher),
    });
  }
}
