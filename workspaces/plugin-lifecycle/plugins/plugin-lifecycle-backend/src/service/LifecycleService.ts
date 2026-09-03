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
import { createHash } from 'crypto';
import type {
  BackstageCredentials,
  PermissionsService,
} from '@backstage/backend-plugin-api';
import {
  parseEntityRef,
  RELATION_DEPENDS_ON,
  RELATION_OWNED_BY,
  stringifyEntityRef,
  type Entity,
} from '@backstage/catalog-model';
import { InputError, NotAllowedError, NotFoundError } from '@backstage/errors';
import type { CatalogService } from '@backstage/plugin-catalog-node';
import { AuthorizeResult } from '@backstage/plugin-permission-common';
import {
  API_SCHEMA_VERSION,
  type CatalogEntitySummary,
  type CreateChangeInput,
  type CreateChangeOutput,
  type Delivery,
  type DeliveryBuild,
  type DeliveryCandidate,
  type EntityRole,
  type GetContextInput,
  type LifecycleContext,
  type LifecycleProjection,
  type LifecycleState,
  type RecordEventInput,
  type RecordEventOutput,
  createChangeInputSchema,
  getContextInputSchema,
  pluginLifecycleChangeCreatePermission,
  pluginLifecycleChangeReadPermission,
  pluginLifecycleEventCreatePermission,
  pluginLifecycleSyncRunPermission,
  recordEventInputSchema,
} from '@red-hat-developer-hub/backstage-plugin-lifecycle-common';
import { LifecycleStore } from '../database/LifecycleStore';
import type {
  ChangeAssociation,
  CreateChangeOptions,
  LifecycleSubject,
  LifecycleSyncState,
  StoredChange,
} from '../database/types';
import { requirePermission } from './authorization';

const ANNOTATION_SOURCE = 'rhdh.io/source-entity-ref';
const ANNOTATION_PLUGINS = 'rhdh.io/extensions-plugin-refs';
const ANNOTATION_PACKAGES = 'rhdh.io/extensions-package-refs';

function canonicalEntityRef(entityRef: string): string {
  try {
    return stringifyEntityRef(
      parseEntityRef(entityRef, {
        defaultKind: 'Component',
        defaultNamespace: 'default',
      }),
    );
  } catch (error) {
    throw new InputError(
      `Invalid Catalog entity reference: ${entityRef}`,
      error,
    );
  }
}

function actorRef(credentials: BackstageCredentials): string {
  const principal = credentials.principal as {
    type: string;
    userEntityRef?: string;
    subject?: string;
  };
  if (principal.type === 'user' && principal.userEntityRef) {
    return principal.userEntityRef;
  }
  return `${principal.type}:${principal.subject ?? 'unknown'}`;
}

function requireHumanIdentity(credentials: BackstageCredentials): void {
  const principal = credentials.principal as { type?: string };
  if (principal.type !== 'user') {
    throw new NotAllowedError(
      'Plugin Lifecycle requires authenticated human credentials',
    );
  }
}

function stringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === 'string');
  }
  return typeof value === 'string' ? [value] : [];
}

function annotationRefs(entity: Entity, key: string): string[] {
  const value = entity.metadata.annotations?.[key];
  return (value ?? '')
    .split(',')
    .map(ref => ref.trim())
    .filter(Boolean)
    .map(canonicalEntityRef);
}

function isOverlayComponent(entity: Entity): boolean {
  return (
    entity.kind.toLocaleLowerCase('en-US') === 'component' &&
    entity.spec?.type === 'rhdh-overlay-workspace'
  );
}

function relationRefs(entity: Entity, relationType: string): string[] {
  return (entity.relations ?? [])
    .filter(relation => relation.type === relationType)
    .map(relation => canonicalEntityRef(relation.targetRef));
}

function ownerRef(entity?: Entity): string | undefined {
  return entity?.relations?.find(
    relation => relation.type === RELATION_OWNED_BY,
  )?.targetRef;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValues(value: unknown): string[] {
  return stringList(value).filter(Boolean);
}

function supportLabel(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  const support = recordValue(value);
  if (!support) return undefined;
  const provider =
    typeof support.provider === 'string' ? support.provider : undefined;
  const level = typeof support.level === 'string' ? support.level : undefined;
  return [provider, level].filter(Boolean).join(' · ') || undefined;
}

function entitySummary(
  entityRef: string,
  role: EntityRole,
  entity?: Entity,
): CatalogEntitySummary {
  const parsed = parseEntityRef(entityRef);
  const backstage = recordValue(entity?.spec?.backstage);
  const supportedVersions = [
    ...stringValues(entity?.spec?.supportedVersions),
    ...stringValues(backstage?.supportedVersions),
  ];
  return {
    entityRef,
    role,
    catalogStatus: entity ? 'available' : 'missing',
    kind: entity?.kind ?? parsed.kind,
    namespace: entity?.metadata.namespace ?? parsed.namespace,
    name: entity?.metadata.name ?? parsed.name,
    title: entity?.metadata.title,
    description: entity?.metadata.description,
    type: typeof entity?.spec?.type === 'string' ? entity.spec.type : undefined,
    ownerRef: ownerRef(entity),
    packageName:
      typeof entity?.spec?.packageName === 'string'
        ? entity.spec.packageName
        : undefined,
    version:
      typeof entity?.spec?.version === 'string'
        ? entity.spec.version
        : undefined,
    dynamicArtifact:
      typeof entity?.spec?.dynamicArtifact === 'string'
        ? entity.spec.dynamicArtifact
        : undefined,
    supportedVersions: [...new Set(supportedVersions)],
    support: supportLabel(entity?.spec?.support),
  };
}

function uniqueAssociations(
  associations: ChangeAssociation[],
): ChangeAssociation[] {
  const seen = new Set<string>();
  return associations.filter(association => {
    const key = `${association.entityRef}:${association.role}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function runTime(run: {
  updatedAt?: string;
  completedAt?: string;
  startedAt?: string;
}): number {
  return (
    Date.parse(run.updatedAt ?? run.completedAt ?? run.startedAt ?? '') || 0
  );
}

function isMainlineBranch(branch?: string): boolean {
  return Boolean(
    branch &&
      (branch === 'main' ||
        branch === 'master' ||
        branch.startsWith('release-') ||
        branch.startsWith('release/')),
  );
}

function deliveryBuild(
  run: LifecycleProjection['ciRuns'][number],
): DeliveryBuild {
  const commitUrl =
    run.repository && run.commitSha
      ? `https://github.com/${run.repository}/commit/${run.commitSha}`
      : undefined;
  return {
    runId: run.runId,
    runNumber: run.runNumber,
    runAttempt: run.runAttempt ?? run.attempt,
    status: run.status,
    conclusion: run.conclusion,
    repository: run.repository,
    branch: run.branch,
    commitSha: run.commitSha,
    commitUrl,
    jobName: run.jobName,
    url: run.url,
    updatedAt: run.updatedAt ?? run.completedAt ?? run.startedAt,
  };
}

function runStatus(
  run: LifecycleProjection['ciRuns'][number] | undefined,
): 'unknown' | 'pending' | 'running' | 'success' | 'failure' {
  if (!run) return 'unknown';
  if (run.status === 'queued') return 'pending';
  if (run.status === 'in_progress') return 'running';
  return run.conclusion === 'success' ? 'success' : 'failure';
}

function phaseRunStatus(
  state: LifecycleState | undefined,
): 'unknown' | 'pending' | 'running' | 'success' | 'failure' {
  switch (state) {
    case 'succeeded':
      return 'success';
    case 'failed':
    case 'blocked':
      return 'failure';
    case 'running':
      return 'running';
    case 'pending':
      return 'pending';
    default:
      return 'unknown';
  }
}

function verificationStatus(
  state: LifecycleState,
): DeliveryCandidate['smokeTestStatus'] {
  switch (state) {
    case 'succeeded':
      return 'success';
    case 'failed':
    case 'blocked':
      return 'failure';
    case 'running':
      return 'running';
    default:
      return 'pending';
  }
}

function packageRefsForPlugin(entity?: Entity): Set<string> | undefined {
  if (!entity || entity.kind.toLocaleLowerCase('en-US') !== 'plugin')
    return undefined;
  const namespace = entity.metadata.namespace ?? 'default';
  const values = Array.isArray(entity.spec?.packages)
    ? entity.spec?.packages
    : [];
  return new Set(
    values
      .map(value => (typeof value === 'string' ? value : undefined))
      .filter((value): value is string => Boolean(value))
      .map(value => {
        if (value.includes(':')) return canonicalEntityRef(value);
        return canonicalEntityRef(`package:${namespace}/${value}`);
      }),
  );
}

const DEFAULT_REFRESH_WAIT_TIMEOUT_MS = 15_000;

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
    this.requireOverlayEntity(subjectEntityRef, entity);
    const associations = await this.resolveAssociations(entity, credentials);
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
    if (this.store.updateExternalStatus)
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

  /** Resolves the durable association set used by system collectors. */
  async associationsForEntity(entity: Entity): Promise<ChangeAssociation[]> {
    this.requireOverlayEntity(stringifyEntityRef(entity), entity);
    return this.resolveAssociations(entity);
  }

  /** Reconciles overlay Components into durable subjects without contacting GitHub. */
  async reconcileCatalog(credentials: BackstageCredentials): Promise<number> {
    const response = await this.catalog.queryEntities(
      { filter: [{ kind: 'Component' }], limit: 500 },
      { credentials },
    );
    const overlays = response.items.filter(isOverlayComponent);
    for (const overlay of overlays)
      await this.reconcileOverlay(overlay, credentials);
    return overlays.length;
  }

  /** Revalidates one subject before an on-demand refresh. */
  async reconcileSubject(
    overlay: Entity,
    credentials: BackstageCredentials,
  ): Promise<void> {
    this.requireOverlayEntity(stringifyEntityRef(overlay), overlay);
    await this.reconcileOverlay(overlay, credentials);
  }

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
    if (!this.refresher)
      throw new InputError(
        'Plugin Lifecycle synchronization is not configured on this backend',
      );
    // GitHub collection may involve many workflow, job, PR, status, and
    // artifact requests. Do not hold the user's HTTP request open until every
    // request completes. The collector keeps the deduplicated in-flight work
    // alive; this call returns the durable context once the bounded wait is
    // reached, including a running sync status that the UI/agent can observe.
    const refreshPromise = this.refresher(canonicalEntityRef(entityRef));
    refreshPromise.catch(() => undefined);
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    const timeoutPromise = new Promise<void>(resolve => {
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        resolve();
      }, Math.max(1_000, this.refreshWaitTimeoutMs));
    });
    try {
      await Promise.race([refreshPromise, timeoutPromise]);
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

  private buildDelivery(
    subject: CatalogEntitySummary,
    summaries: CatalogEntitySummary[],
    overlayEntity: Entity | undefined,
    requestedEntity: Entity | undefined,
    changes: StoredChange[],
    syncState: LifecycleSyncState,
  ): Delivery {
    const pluginPackageRefs = packageRefsForPlugin(requestedEntity);
    const packageSummaries = summaries.filter(summary => {
      if (summary.role !== 'package') return false;
      // A binding to a missing entity is a mapping diagnostic, not proof that
      // a customer-available package exists in the Extensions Catalog.
      if (summary.catalogStatus !== 'available') return false;
      return !pluginPackageRefs || pluginPackageRefs.has(summary.entityRef);
    });
    const releasedPackages = packageSummaries.map(pkg => ({
      entityRef: pkg.entityRef,
      packageName: pkg.packageName,
      version: pkg.version,
      ociReference: pkg.dynamicArtifact,
      support: pkg.support,
      supportedVersions: pkg.supportedVersions,
      evidence: 'catalog_reported' as const,
    }));

    const activeCandidates: DeliveryCandidate[] = changes
      .filter(
        change =>
          change.summary.scope === 'pull_request' &&
          change.summary.externalStatus === 'open' &&
          change.summary.origin !== 'fixture',
      )
      .map(change => {
        const runs = change.projection.ciRuns
          .filter(run => !run.fixture)
          .sort((left, right) => runTime(right) - runTime(left));
        const publishCheck = runs.find(
          run =>
            run.provider === 'github-commit-status' &&
            run.jobName === 'publish',
        );
        const smokeCheck = runs.find(
          run =>
            run.provider === 'github-commit-status' &&
            run.jobName === 'smoketest',
        );
        const latestRun = runs.find(
          run => run.provider !== 'github-commit-status',
        );
        const verification = change.projection.phaseStates?.find(
          state => state.phase === 'verification',
        );
        const buildPhase = change.projection.phaseStates?.find(
          state => state.phase === 'build',
        );
        const pullRequest = change.projection.references.find(
          reference => reference.type === 'pull_request',
        );
        const sourceReference = change.projection.references.find(
          reference => reference.type === 'source',
        );
        const publishStatus = publishCheck
          ? runStatus(publishCheck)
          : phaseRunStatus(buildPhase?.state);
        const smokeCheckStatus = smokeCheck ? runStatus(smokeCheck) : undefined;
        let smokeTestStatus: DeliveryCandidate['smokeTestStatus'] = 'not_run';
        if (smokeCheckStatus && smokeCheckStatus !== 'unknown') {
          smokeTestStatus = smokeCheckStatus;
        } else if (verification) {
          smokeTestStatus = verificationStatus(verification.state);
        }
        const candidateImages = change.projection.artifacts
          .filter(artifact => artifact.artifactType === 'oci')
          .map(artifact => ({
            reference: artifact.reference,
            packageEntityRef: artifact.packageEntityRef,
            version: artifact.version,
            observedAt:
              change.summary.lastOccurredAt ?? change.summary.updatedAt,
          }));
        let blocker = change.projection.blocker;
        if (!blocker && publishStatus === 'failure') {
          blocker = 'The candidate publish check failed.';
        }
        if (!blocker && smokeTestStatus === 'failure') {
          blocker = 'The candidate smoke test failed.';
        }
        if (
          !blocker &&
          publishStatus === 'success' &&
          candidateImages.length === 0
        ) {
          blocker =
            'The publish check succeeded, but the candidate image artifact is unavailable or expired.';
        }
        if (!blocker && publishStatus === 'unknown') {
          blocker =
            'No publish check result is available for this open pull request.';
        }
        let nextAction: string | undefined;
        let nextActionUrl: string | undefined;
        let nextActionLabel: string | undefined;
        if (publishStatus === 'failure' || smokeTestStatus === 'failure') {
          nextAction = 'Inspect the failing check and update the pull request.';
          nextActionUrl =
            publishStatus === 'failure'
              ? publishCheck?.url ?? buildPhase?.evidenceUrl
              : smokeCheck?.url ?? verification?.evidenceUrl;
          nextActionLabel =
            publishStatus === 'failure'
              ? 'Inspect failed publish check'
              : 'Inspect failed smoke test';
        } else if (publishStatus === 'unknown') {
          nextAction = 'Run or refresh the pull request publish workflow.';
          nextActionUrl = pullRequest?.url;
          nextActionLabel = 'Open pull request';
        } else if (
          publishStatus === 'success' &&
          smokeTestStatus === 'not_run'
        ) {
          nextAction = 'Install and test the candidate OCI images.';
          nextActionUrl = publishCheck?.url ?? buildPhase?.evidenceUrl;
          nextActionLabel = 'Open candidate publish evidence';
        } else if (smokeTestStatus === 'success') {
          nextAction = 'Review the pull request for merge.';
          nextActionUrl = pullRequest?.url;
          nextActionLabel = 'Review pull request';
        }
        return {
          changeId: change.summary.changeId,
          title: change.summary.title,
          author: pullRequest?.author,
          pullRequestNumber:
            latestRun?.pullRequestNumber ??
            (pullRequest?.externalId
              ? Number.parseInt(pullRequest.externalId, 10)
              : undefined),
          pullRequestUrl: pullRequest?.url,
          sourceRevision:
            publishCheck?.sourceCommitSha ??
            publishCheck?.commitSha ??
            latestRun?.sourceCommitSha ??
            latestRun?.commitSha ??
            sourceReference?.externalId,
          sourceUrl: sourceReference?.url,
          updatedAt:
            pullRequest?.updatedAt ??
            change.summary.lastOccurredAt ??
            change.summary.updatedAt,
          publishStatus,
          publishUrl:
            publishCheck?.url ?? latestRun?.url ?? buildPhase?.evidenceUrl,
          smokeTestStatus,
          smokeTestUrl: smokeCheck?.url ?? verification?.evidenceUrl,
          candidateImages,
          blocker,
          nextAction,
          nextActionUrl,
          nextActionLabel,
        };
      });

    const branchChanges = changes.filter(
      change =>
        change.summary.scope === 'branch' &&
        change.summary.origin !== 'fixture',
    );
    const mainlineRuns = branchChanges
      .flatMap(change => change.projection.ciRuns)
      .filter(run => !run.fixture && isMainlineBranch(run.branch))
      .sort((left, right) => runTime(right) - runTime(left));
    const latestBuild = mainlineRuns[0];
    const latestSuccessfulBuild = mainlineRuns.find(
      run => run.status === 'completed' && run.conclusion === 'success',
    );

    let status: Delivery['status'] = 'unknown';
    let statusReason = 'No live delivery evidence has been synchronized yet.';
    let nextAction: string | undefined;
    let nextActionUrl: string | undefined;
    let nextActionLabel: string | undefined;
    const failedCandidate = activeCandidates.find(
      candidate =>
        candidate.publishStatus === 'failure' ||
        candidate.smokeTestStatus === 'failure',
    );
    const runningCandidate = activeCandidates.find(candidate =>
      ['pending', 'running'].includes(candidate.publishStatus),
    );
    const runningVerification = activeCandidates.find(candidate =>
      ['pending', 'running'].includes(candidate.smokeTestStatus),
    );
    const testableCandidate = activeCandidates.find(
      candidate =>
        candidate.publishStatus === 'success' &&
        candidate.smokeTestStatus === 'not_run' &&
        candidate.candidateImages.length > 0,
    );
    const mergeableCandidate = activeCandidates.find(
      candidate =>
        candidate.publishStatus === 'success' &&
        candidate.smokeTestStatus === 'success' &&
        candidate.candidateImages.length > 0,
    );
    const missingCandidateEvidence = activeCandidates.find(
      candidate =>
        candidate.publishStatus === 'unknown' ||
        (candidate.publishStatus === 'success' &&
          candidate.candidateImages.length === 0),
    );
    if (failedCandidate) {
      status = 'attention_required';
      statusReason = failedCandidate.blocker ?? 'A candidate check failed.';
      nextAction = failedCandidate.nextAction;
      nextActionUrl = failedCandidate.nextActionUrl;
      nextActionLabel = failedCandidate.nextActionLabel;
    } else if (runningCandidate) {
      status = 'in_progress';
      statusReason = 'A candidate build is still running.';
      nextAction = 'Wait for the candidate checks to finish.';
      nextActionUrl = runningCandidate.publishUrl;
      nextActionLabel = 'Open running publish check';
    } else if (runningVerification) {
      status = 'in_progress';
      statusReason = 'A candidate smoke test is still running.';
      nextAction = 'Wait for the candidate smoke test to finish.';
      nextActionUrl = runningVerification.smokeTestUrl;
      nextActionLabel = 'Open running smoke test';
    } else if (testableCandidate) {
      status = 'ready_to_test';
      statusReason = 'Candidate images are available and need verification.';
      nextAction = testableCandidate.nextAction;
      nextActionUrl = testableCandidate.nextActionUrl;
      nextActionLabel = testableCandidate.nextActionLabel;
    } else if (mergeableCandidate) {
      status = 'ready_to_merge';
      statusReason = 'Candidate verification succeeded.';
      nextAction = mergeableCandidate.nextAction;
      nextActionUrl = mergeableCandidate.nextActionUrl;
      nextActionLabel = mergeableCandidate.nextActionLabel;
    } else if (missingCandidateEvidence) {
      status = 'unknown';
      statusReason =
        missingCandidateEvidence.blocker ??
        'Candidate publication evidence is incomplete.';
      nextAction =
        'Refresh or rerun the PR publish workflow to restore its artifact.';
      nextActionUrl = missingCandidateEvidence.pullRequestUrl;
      nextActionLabel = 'Open pull request';
    } else if (
      latestBuild &&
      (latestBuild.status !== 'completed' ||
        latestBuild.conclusion === 'failure')
    ) {
      status =
        latestBuild.status === 'completed'
          ? 'attention_required'
          : 'in_progress';
      statusReason =
        latestBuild.status === 'completed'
          ? 'The latest mainline workspace build failed.'
          : 'The latest mainline workspace build is still running.';
      nextAction = latestBuild.url
        ? 'Inspect the latest mainline build.'
        : undefined;
      nextActionUrl = latestBuild.url;
      nextActionLabel =
        latestBuild.status === 'completed'
          ? 'Inspect failed workspace job'
          : 'Open running workspace job';
    } else if (
      latestBuild?.status === 'completed' &&
      latestBuild.conclusion === 'success'
    ) {
      status = 'stable';
      statusReason =
        'The latest mainline workspace build succeeded and no active delivery issue was observed.';
    } else if (releasedPackages.length > 0) {
      status = 'unknown';
      statusReason =
        'A Catalog-listed release is available, but no current candidate or mainline build evidence was found.';
    }

    return {
      status,
      statusReason,
      ownerRef:
        summaries.find(summary => summary.role === 'source')?.ownerRef ??
        subject.ownerRef,
      workspace:
        overlayEntity?.metadata.annotations?.['rhdh.io/overlay-workspace'] ??
        subject.name.replace(/^overlay-/, ''),
      releasedPackages,
      activeCandidates,
      mainline: {
        latestBuild: latestBuild ? deliveryBuild(latestBuild) : undefined,
        latestSuccessfulBuild: latestSuccessfulBuild
          ? deliveryBuild(latestSuccessfulBuild)
          : undefined,
      },
      nextAction,
      nextActionUrl,
      nextActionLabel,
      freshness: {
        syncStatus: syncState.status,
        lastSuccessAt: syncState.lastSuccessAt,
        stale:
          !syncState.lastSuccessAt ||
          Date.now() - new Date(syncState.lastSuccessAt).getTime() > 60_000,
      },
    };
  }

  async getContext(
    rawInput: GetContextInput,
    credentials: BackstageCredentials,
  ): Promise<LifecycleContext> {
    requireHumanIdentity(credentials);
    const input = getContextInputSchema.parse(rawInput);
    const requestedEntityRef = canonicalEntityRef(input.entityRef);
    await requirePermission(
      this.permissions,
      credentials,
      pluginLifecycleChangeReadPermission,
      'Plugin Lifecycle read permission is required',
    );
    const requestedEntity = await this.catalog.getEntityByRef(
      requestedEntityRef,
      { credentials },
    );
    const stored = await this.store.getContext(requestedEntityRef, input);
    const selectedSubjectRef =
      stored.selectedChange?.subjectEntityRef ?? requestedEntityRef;
    const selectedSubject = await this.catalog.getEntityByRef(
      selectedSubjectRef,
      { credentials },
    );
    const subject = this.store.getSubjectByEntity
      ? await this.store.getSubjectByEntity(requestedEntityRef)
      : undefined;
    const syncState =
      subject && this.store.getSyncState
        ? await this.store.getSyncState(subject.id)
        : { status: 'never' as const };
    const syncDecision = await this.permissions.authorize(
      [{ permission: pluginLifecycleSyncRunPermission }],
      { credentials },
    );
    const canRefresh =
      syncDecision[0]?.result === AuthorizeResult.ALLOW &&
      Boolean(this.refresher);
    const bootstrapStatus =
      this.bootstrapKey && this.store.getBootstrapStatus
        ? await this.store.getBootstrapStatus(this.bootstrapKey)
        : undefined;
    let associationRows: ChangeAssociation[] = [];
    if (stored.selectedChange) {
      associationRows = await this.store.getAssociations(
        stored.selectedChange.changeId,
      );
    } else if (requestedEntity && isOverlayComponent(requestedEntity)) {
      associationRows = await this.resolveAssociations(
        requestedEntity,
        credentials,
      );
    } else {
      const storedSubject = this.store.getSubjectByEntity
        ? await this.store.getSubjectByEntity(requestedEntityRef)
        : undefined;
      if (storedSubject && this.store.getSubjectBindings) {
        const bindings = await this.store.getSubjectBindings(storedSubject.id);
        associationRows = [
          {
            entityRef: storedSubject.overlayEntityRef,
            role: 'subject',
            relationSource: 'subject',
          },
          ...bindings.map(binding => ({
            entityRef: binding.entityRef,
            role: (binding.role === 'overlay'
              ? 'overlay'
              : binding.role) as ChangeAssociation['role'],
            relationSource: 'catalog-annotation' as const,
          })),
        ];
      }
    }
    const summaries = await this.summarizeAssociations(
      associationRows,
      credentials,
    );
    const warnings = summaries
      .filter(summary => summary.catalogStatus === 'missing')
      .map(summary => ({
        code: 'catalog-entity-missing',
        message: `${summary.role} entity ${summary.entityRef} is not currently in the Catalog`,
        entityRef: summary.entityRef,
      }));
    if (!requestedEntity) {
      warnings.unshift({
        code: 'requested-entity-missing',
        message: `Requested entity ${requestedEntityRef} is not currently in the Catalog`,
        entityRef: requestedEntityRef,
      });
    }
    const subjectSummary =
      summaries.find(summary => summary.role === 'subject') ??
      entitySummary(selectedSubjectRef, 'subject', selectedSubject);
    const relatedEntities = summaries.filter(
      summary =>
        summary.entityRef !== subjectSummary.entityRef ||
        summary.role !== subjectSummary.role,
    );
    const mappingStatus =
      subject?.mappingStatus ??
      (associationRows.length > 0 ? 'complete' : 'missing');
    let overlayEntityForDelivery: Entity | undefined;
    if (requestedEntity && isOverlayComponent(requestedEntity)) {
      overlayEntityForDelivery = requestedEntity;
    } else if (subject) {
      overlayEntityForDelivery = await this.catalog.getEntityByRef(
        subject.overlayEntityRef,
        { credentials },
      );
    }
    const delivery =
      input.asOf || input.asOfEventId
        ? undefined
        : this.buildDelivery(
            subjectSummary,
            summaries,
            overlayEntityForDelivery,
            requestedEntity,
            await this.store.getChangeDetails(requestedEntityRef),
            syncState,
          );
    return {
      schemaVersion: API_SCHEMA_VERSION,
      requestedEntityRef,
      subject: subjectSummary,
      relatedEntities,
      warnings,
      ...stored,
      delivery,
      asOf: input.asOf,
      asOfEventId: input.asOfEventId,
      resolution: {
        requestedEntityRef,
        canonicalSubjectRef: subjectSummary.entityRef,
        requestedEntityRole:
          associationRows.find(
            association => association.entityRef === requestedEntityRef,
          )?.role ?? 'subject',
        mappingStatus,
      },
      sync: {
        status: syncState.status,
        bootstrapStatus,
        refreshAttempted: false,
        stale:
          !syncState.lastSuccessAt ||
          Date.now() - new Date(syncState.lastSuccessAt).getTime() > 60_000,
        lastAttemptAt: syncState.lastAttemptAt,
        lastSuccessAt: syncState.lastSuccessAt,
        errorSummary: syncState.errorSummary,
        canRefresh,
      },
    };
  }

  private requireOverlayEntity(
    entityRef: string,
    entity: Entity | undefined,
  ): asserts entity is Entity {
    if (!entity) {
      throw new NotFoundError(`Catalog entity "${entityRef}" was not found`);
    }
    if (!isOverlayComponent(entity)) {
      throw new InputError(
        `Lifecycle changes require an rhdh-overlay-workspace Component, received ${entity.kind}`,
      );
    }
  }

  private async resolveAssociations(
    overlay: Entity,
    credentials?: BackstageCredentials,
  ): Promise<ChangeAssociation[]> {
    const overlayRef = stringifyEntityRef(overlay);
    const sourceRefs = [
      ...relationRefs(overlay, RELATION_DEPENDS_ON),
      ...annotationRefs(overlay, ANNOTATION_SOURCE),
    ].filter(ref => ref.toLocaleLowerCase('en-US').startsWith('component:'));
    const pluginRefs = annotationRefs(overlay, ANNOTATION_PLUGINS).filter(ref =>
      ref.toLocaleLowerCase('en-US').startsWith('plugin:'),
    );
    const packageRefs = annotationRefs(overlay, ANNOTATION_PACKAGES).filter(
      ref => ref.toLocaleLowerCase('en-US').startsWith('package:'),
    );
    const associations: ChangeAssociation[] = [
      {
        entityRef: overlayRef,
        role: 'subject',
        relationSource: 'subject',
      },
      {
        entityRef: overlayRef,
        role: 'overlay',
        relationSource: 'subject',
      },
      ...sourceRefs.map(entityRef => ({
        entityRef,
        role: 'source' as const,
        relationSource: 'catalog-relation' as const,
      })),
      ...pluginRefs.map(entityRef => ({
        entityRef,
        role: 'extension-plugin' as const,
        relationSource: 'catalog-annotation' as const,
      })),
      ...packageRefs.map(entityRef => ({
        entityRef,
        role: 'package' as const,
        relationSource: 'catalog-annotation' as const,
      })),
    ];
    if (credentials) {
      const refs = uniqueAssociations(associations);
      await Promise.all(
        refs
          .filter(association => association.role !== 'subject')
          .map(async association => {
            await this.catalog.getEntityByRef(association.entityRef, {
              credentials,
            });
          }),
      );
    }
    return uniqueAssociations(associations);
  }

  private async reconcileOverlay(
    overlay: Entity,
    credentials: BackstageCredentials,
  ): Promise<void> {
    const associations = await this.resolveAssociations(overlay, credentials);
    const overlayRef = canonicalEntityRef(stringifyEntityRef(overlay));
    const annotations = overlay.metadata.annotations ?? {};
    const checked = await Promise.all(
      associations
        .filter(association => association.role !== 'subject')
        .map(async association => ({
          association,
          exists: Boolean(
            await this.catalog.getEntityByRef(association.entityRef, {
              credentials,
            }),
          ),
        })),
    );
    const mapping = checked
      .map(entry => entry.association)
      .filter(association => association.role !== 'subject')
      .map(association => {
        const exists = checked.find(
          entry => entry.association === association,
        )?.exists;
        return `${association.role}:${association.entityRef}:${
          exists ? 'available' : 'missing'
        }`;
      })
      .sort();
    const referencedEntities = checked.filter(
      entry => entry.association.role !== 'overlay',
    );
    let mappingStatus: 'complete' | 'incomplete' | 'missing';
    if (referencedEntities.length === 0) {
      mappingStatus = 'missing';
    } else if (referencedEntities.every(entry => entry.exists)) {
      mappingStatus = 'complete';
    } else {
      mappingStatus = 'incomplete';
    }
    await this.store.upsertSubject({
      overlayEntityRef: overlayRef,
      workspace:
        annotations['rhdh.io/overlay-workspace'] ?? overlay.metadata.name,
      overlayRepository: annotations['github.com/project-slug'] ?? '',
      sourceRepository: annotations['rhdh.io/source-repository'],
      sourceRevision:
        annotations['rhdh.io/source-revision'] ??
        annotations['rhdh.io/source-commit-sha'],
      mappingStatus,
      mappingHash: createHash('sha256').update(mapping.join('|')).digest('hex'),
      bindings: checked
        .filter(entry => entry.association.role !== 'subject')
        .map(entry => ({
          entityRef: entry.association.entityRef,
          role: (entry.association.role === 'overlay'
            ? 'overlay'
            : entry.association.role) as Exclude<
            ChangeAssociation['role'],
            'subject'
          >,
          bindingSource: entry.association.relationSource,
          status: entry.exists ? ('available' as const) : ('missing' as const),
        })),
    });
  }

  private async summarizeAssociations(
    associations: ChangeAssociation[],
    credentials: BackstageCredentials,
  ): Promise<CatalogEntitySummary[]> {
    const summaries = await Promise.all(
      associations.map(async association => {
        const entity = await this.catalog.getEntityByRef(
          association.entityRef,
          {
            credentials,
          },
        );
        return entitySummary(association.entityRef, association.role, entity);
      }),
    );
    return summaries;
  }
}
