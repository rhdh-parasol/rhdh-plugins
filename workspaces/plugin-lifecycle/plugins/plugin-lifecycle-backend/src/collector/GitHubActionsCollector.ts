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
import type { AuthService, LoggerService } from '@backstage/backend-plugin-api';
import type { Entity } from '@backstage/catalog-model';
import type { CatalogService } from '@backstage/plugin-catalog-node';
import type { LifecycleService } from '../service/LifecycleService';
import { queryAllCatalogEntities } from '../catalogQuery';
import { collectWorkflowEvidence } from './workflowEvidence';
import { isGitHubRateLimited } from './githubClient';
import {
  catalogEntityRef,
  deferred,
  isOverlay,
  newCollectionCache,
  rateLimitResetAt,
  slug,
  type CollectionCache,
  type Deferred,
} from './collectorHelpers';
import { type GitHubActionsReader } from './githubReader';

export {
  GitHubRestActionsReader,
  GitHubRequestError,
  isGitHubRateLimited,
} from './githubReader';
export type {
  GitHubActionsReader,
  GitHubCommitStatus,
  GitHubPullRequest,
  GitHubWorkflowJob,
  GitHubWorkflowRun,
  GitHubWorkspaceSource,
  LifecycleManifest,
  PublishedExports,
} from './githubReader';

export interface CollectorResult {
  overlays: number;
  changes: number;
  events: number;
  diagnostics: number;
}

export class GitHubActionsCollector {
  private static readonly DEFAULT_CLOSED_PULL_REQUESTS_PER_WORKSPACE = 3;
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly refreshedAt = new Map<string, number>();
  private readonly rateLimitUntil = new Map<string, number>();
  private readonly repositoryCaches = new Map<
    string,
    { expiresAt: number; cache: CollectionCache }
  >();
  private readonly bootstrapPending = new Map<
    string,
    { overlay: Entity; completion: Deferred }
  >();
  private readonly bootstrapPriority = new Set<string>();
  private bootstrapCache?: CollectionCache;
  private bootstrapRunning = false;
  constructor(
    private readonly service: LifecycleService,
    private readonly catalog: CatalogService,
    private readonly auth: AuthService,
    private readonly reader: GitHubActionsReader,
    private readonly logger: LoggerService,
    private readonly workflowFile = 'publish-workspace-plugins.yaml',
    private readonly requireManifest = false,
    private readonly allowedRepository?: string | readonly string[],
    private readonly closedPullRequestsPerWorkspace = GitHubActionsCollector.DEFAULT_CLOSED_PULL_REQUESTS_PER_WORKSPACE,
  ) {}

  async collect(): Promise<CollectorResult> {
    const credentials = await this.auth.getOwnServiceCredentials();
    const catalogEntities = await queryAllCatalogEntities(
      this.catalog,
      { filter: [{ kind: 'Component' }], limit: 500 },
      credentials,
    );
    const configuredRepository = this.allowedRepository;
    let allowedRepositories: readonly string[] | undefined;
    if (typeof configuredRepository === 'string') {
      allowedRepositories = [configuredRepository];
    } else if (configuredRepository) {
      allowedRepositories = configuredRepository;
    }
    const overlays = catalogEntities.filter(entity => {
      const repository = slug(entity);
      if (!isOverlay(entity) || !repository) return false;
      return !allowedRepositories || allowedRepositories.includes(repository);
    });
    const result: CollectorResult = {
      overlays: overlays.length,
      changes: 0,
      events: 0,
      diagnostics: 0,
    };
    const cache = newCollectionCache();
    this.bootstrapCache = cache;
    this.bootstrapRunning = true;
    for (const overlay of overlays) {
      const overlayRef = catalogEntityRef(overlay);
      this.bootstrapPending.set(overlayRef, {
        overlay,
        completion: deferred(),
      });
      await this.updateSyncState(overlayRef, {
        status: 'pending',
        lastAttemptAt: new Date().toISOString(),
      });
    }
    try {
      while (this.bootstrapPending.size > 0) {
        const prioritized = [...this.bootstrapPriority].find(ref =>
          this.bootstrapPending.has(ref),
        );
        const overlayRef =
          prioritized ?? this.bootstrapPending.keys().next().value;
        if (!overlayRef) break;
        this.bootstrapPriority.delete(overlayRef);
        const pending = this.bootstrapPending.get(overlayRef);
        if (!pending) continue;
        // Track bootstrap work in the same in-flight map used by on-demand
        // refreshes. A user request that arrives after this loop has selected
        // the subject must await the current collection instead of starting a
        // second set of GitHub requests for the same repository/run data.
        const collection = this.collectOverlay(pending.overlay, cache, true);
        const tracked = collection.then(() => undefined);
        this.inFlight.set(overlayRef, tracked);
        try {
          const outcome = await collection;
          result.changes += outcome.changes;
          result.events += outcome.events;
          pending.completion.resolve(true);
        } catch (error) {
          result.diagnostics += 1;
          await this.updateSyncState(overlayRef, {
            status: isGitHubRateLimited(error) ? 'rate_limited' : 'failed',
            lastAttemptAt: new Date().toISOString(),
            errorSummary:
              error instanceof Error ? error.message : String(error),
            rateLimitResetAt: rateLimitResetAt(error),
          });
          // The durable sync state carries the failure; resolve waiters so a
          // prioritized refresh can return the retained cached context.
          pending.completion.resolve(false);
          this.logger.warn(
            `Plugin lifecycle GitHub collection failed for ${pending.overlay.metadata.name}`,
            error as Error,
          );
        } finally {
          if (this.inFlight.get(overlayRef) === tracked) {
            this.inFlight.delete(overlayRef);
          }
          this.bootstrapPending.delete(overlayRef);
        }
      }
    } finally {
      this.bootstrapRunning = false;
      this.bootstrapCache = undefined;
      for (const pending of this.bootstrapPending.values()) {
        pending.completion.resolve(false);
      }
      this.bootstrapPending.clear();
      this.bootstrapPriority.clear();
    }
    return result;
  }

  async refreshSubject(entityRef: string): Promise<void> {
    const credentials = await this.auth.getOwnServiceCredentials();
    const overlay = await this.findOverlay(entityRef, credentials);
    if (!overlay) {
      throw new Error(
        `No lifecycle overlay subject was found for ${entityRef}`,
      );
    }
    await this.service.reconcileSubject(overlay, credentials);
    const overlayRef = catalogEntityRef(overlay);
    const inFlight = this.inFlight.get(overlayRef);
    if (inFlight) {
      await inFlight;
      return;
    }
    const lastRefresh = this.refreshedAt.get(overlayRef);
    if (lastRefresh && Date.now() - lastRefresh < 60_000) return;
    // A subject that is still waiting in the one-time bootstrap queue must
    // not make a user wait behind every other overlay. Remove it from the
    // normal queue and run it immediately with the repository cache. If the
    // queue already started that subject, the two observations may overlap;
    // event IDs and projections keep the result idempotent.
    const queuedForBootstrap =
      this.bootstrapRunning && this.bootstrapPending.has(overlayRef);
    if (queuedForBootstrap) {
      this.bootstrapPending.delete(overlayRef);
      this.bootstrapPriority.delete(overlayRef);
    }
    const work = this.refreshOverlay(
      overlay,
      queuedForBootstrap,
      queuedForBootstrap ? this.bootstrapCache : undefined,
    );
    this.inFlight.set(
      overlayRef,
      work.then(() => undefined),
    );
    try {
      const refreshed = await work;
      if (refreshed) this.refreshedAt.set(overlayRef, Date.now());
    } finally {
      this.inFlight.delete(overlayRef);
    }
  }

  private async findOverlay(
    entityRef: string,
    credentials: Awaited<ReturnType<AuthService['getOwnServiceCredentials']>>,
  ): Promise<Entity | undefined> {
    const persistedSubject = await this.service.getSubjectForEntity(entityRef);
    if (persistedSubject) {
      const persistedOverlay = await this.catalog.getEntityByRef(
        persistedSubject.overlayEntityRef,
        { credentials },
      );
      if (persistedOverlay && isOverlay(persistedOverlay)) {
        return persistedOverlay;
      }
    }
    const catalogEntities = await queryAllCatalogEntities(
      this.catalog,
      { filter: [{ kind: 'Component' }], limit: 500 },
      credentials,
    );
    const requested = entityRef.toLocaleLowerCase('en-US');
    for (const overlay of catalogEntities.filter(
      entity => isOverlay(entity) && Boolean(slug(entity)),
    )) {
      if (catalogEntityRef(overlay).toLocaleLowerCase('en-US') === requested) {
        return overlay;
      }
      const associations = await this.service.associationsForEntity(overlay);
      if (
        associations.some(
          association =>
            association.entityRef.toLocaleLowerCase('en-US') === requested,
        )
      ) {
        return overlay;
      }
    }
    return undefined;
  }

  private async refreshOverlay(
    overlay: Entity,
    bypassBootstrapQueue = false,
    cacheOverride?: CollectionCache,
  ): Promise<boolean> {
    const overlayRef = catalogEntityRef(overlay);
    const repository = slug(overlay)!;
    const cache =
      cacheOverride ??
      (() => {
        const existing = this.repositoryCaches.get(repository);
        if (existing && existing.expiresAt > Date.now()) return existing.cache;
        const next = newCollectionCache();
        this.repositoryCaches.set(repository, {
          cache: next,
          expiresAt: Date.now() + 60_000,
        });
        return next;
      })();
    const service = this.service as LifecycleService & {
      getSyncStateForEntity?: LifecycleService['getSyncStateForEntity'];
    };
    const persistedSyncState = service.getSyncStateForEntity
      ? await service.getSyncStateForEntity(overlayRef)
      : undefined;
    const persistedRateLimitUntil = persistedSyncState?.rateLimitResetAt
      ? Date.parse(persistedSyncState.rateLimitResetAt)
      : undefined;
    const rateLimitUntil = Math.max(
      this.rateLimitUntil.get(overlayRef) ?? 0,
      Number.isFinite(persistedRateLimitUntil) ? persistedRateLimitUntil! : 0,
    );
    if (rateLimitUntil > Date.now()) {
      await this.updateSyncState(overlayRef, {
        status: 'rate_limited',
        lastAttemptAt: new Date().toISOString(),
        rateLimitResetAt: new Date(rateLimitUntil).toISOString(),
      });
      return false;
    }
    if (rateLimitUntil) this.rateLimitUntil.delete(overlayRef);
    await this.updateSyncState(overlayRef, {
      status: 'prioritized',
      lastAttemptAt: new Date().toISOString(),
    });
    const pending = this.bootstrapPending.get(overlayRef);
    if (this.bootstrapRunning && pending && !bypassBootstrapQueue) {
      this.bootstrapPriority.add(overlayRef);
      return pending.completion.promise;
    }
    try {
      await this.collectOverlay(overlay, cache);
      return true;
    } catch (error) {
      const failedRepository = slug(overlay);
      if (failedRepository) this.repositoryCaches.delete(failedRepository);
      const resetAt = rateLimitResetAt(error);
      if (resetAt) this.rateLimitUntil.set(overlayRef, Date.parse(resetAt));
      await this.updateSyncState(overlayRef, {
        status: isGitHubRateLimited(error) ? 'rate_limited' : 'failed',
        lastAttemptAt: new Date().toISOString(),
        errorSummary: error instanceof Error ? error.message : String(error),
        rateLimitResetAt: rateLimitResetAt(error),
      });
      this.logger.warn(
        `Plugin lifecycle GitHub refresh failed for ${overlay.metadata.name}`,
        error as Error,
      );
      throw error;
    }
  }

  private async collectOverlay(
    overlay: Entity,
    cache: CollectionCache,
    bootstrap = false,
  ): Promise<{ changes: number; events: number }> {
    return collectWorkflowEvidence({
      overlay,
      cache,
      bootstrap,
      reader: this.reader,
      service: this.service,
      workflowFile: this.workflowFile,
      requireManifest: this.requireManifest,
      closedPullRequestsPerWorkspace: this.closedPullRequestsPerWorkspace,
      updateSyncState: (entityRef, state) =>
        this.updateSyncState(entityRef, state),
    });
  }
  private async updateSyncState(
    entityRef: string,
    state: Parameters<LifecycleService['updateSyncState']>[1],
  ): Promise<void> {
    const service = this.service as LifecycleService & {
      updateSyncState?: LifecycleService['updateSyncState'];
    };
    if (service.updateSyncState)
      await service.updateSyncState(entityRef, state);
  }
}
