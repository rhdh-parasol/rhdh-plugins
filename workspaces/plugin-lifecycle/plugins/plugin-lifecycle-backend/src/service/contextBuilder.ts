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
import type { Entity } from '@backstage/catalog-model';
import type { CatalogService } from '@backstage/plugin-catalog-node';
import { AuthorizeResult } from '@backstage/plugin-permission-common';
import {
  API_SCHEMA_VERSION,
  type GetContextInput,
  type LifecycleContext,
} from '@red-hat-developer-hub/backstage-plugin-lifecycle-common';
import {
  pluginLifecycleChangeReadPermission,
  pluginLifecycleSyncRunPermission,
  getContextInputSchema,
} from '@red-hat-developer-hub/backstage-plugin-lifecycle-common';
import type { LifecycleStore } from '../database/LifecycleStore';
import type {
  ChangeAssociation,
  LifecycleSubject,
  LifecycleSyncState,
} from '../database/types';
import { requirePermission } from './authorization';
import {
  entitySummary,
  isOverlayComponent,
  resolveAssociations,
  summarizeAssociations,
} from './catalogResolution';
import { canonicalEntityRef, requireHumanIdentity } from './identity';
import { buildDelivery } from './deliveryDerivation';

interface ContextBuilderDependencies {
  store: LifecycleStore;
  catalog: CatalogService;
  permissions: PermissionsService;
  bootstrapKey?: string;
  refresherConfigured: boolean;
}

function subjectBindings(
  subject: LifecycleSubject,
  bindings: Awaited<ReturnType<LifecycleStore['getSubjectBindings']>>,
): ChangeAssociation[] {
  return [
    {
      entityRef: subject.overlayEntityRef,
      role: 'subject',
      relationSource: 'subject',
    },
    ...bindings.map(binding => ({
      entityRef: binding.entityRef,
      role: (binding.role === 'overlay' ? 'overlay' : binding.role) as Exclude<
        ChangeAssociation['role'],
        'subject'
      >,
      relationSource: 'catalog-annotation' as const,
    })),
  ];
}

function contextWarnings(
  summaries: Awaited<ReturnType<typeof summarizeAssociations>>,
  requestedEntityRef: string,
  requestedEntity: Entity | undefined,
  ambiguousSubjectMapping: boolean,
) {
  const warnings = summaries
    .filter(summary => summary.catalogStatus === 'missing')
    .map(summary => ({
      code: 'catalog-entity-missing',
      message: `${summary.role} entity ${summary.entityRef} is not currently in the Catalog`,
      entityRef: summary.entityRef,
    }));
  if (ambiguousSubjectMapping) {
    warnings.push({
      code: 'ambiguous-subject-mapping',
      message: `Entity ${requestedEntityRef} maps to multiple lifecycle subjects; showing the most recently observed subject.`,
      entityRef: requestedEntityRef,
    });
  }
  if (!requestedEntity) {
    warnings.unshift({
      code: 'requested-entity-missing',
      message: `Requested entity ${requestedEntityRef} is not currently in the Catalog`,
      entityRef: requestedEntityRef,
    });
  }
  return warnings;
}

/** Builds the REST, Actions, and MCP read model from the same persisted data. */
export async function buildLifecycleContext(
  rawInput: GetContextInput,
  credentials: BackstageCredentials,
  dependencies: ContextBuilderDependencies,
): Promise<LifecycleContext> {
  requireHumanIdentity(credentials);
  const input = getContextInputSchema.parse(rawInput);
  const requestedEntityRef = canonicalEntityRef(input.entityRef);
  const { store, catalog, permissions } = dependencies;
  await requirePermission(
    permissions,
    credentials,
    pluginLifecycleChangeReadPermission,
    'Plugin Lifecycle read permission is required',
  );

  const requestedEntity = await catalog.getEntityByRef(requestedEntityRef, {
    credentials,
  });
  const stored = await store.getContext(requestedEntityRef, input);
  const selectedSubjectRef =
    stored.selectedChange?.subjectEntityRef ?? requestedEntityRef;
  const selectedSubject = await catalog.getEntityByRef(selectedSubjectRef, {
    credentials,
  });
  // Keep the builder tolerant of lightweight store doubles used by consumers
  // and tests. The concrete LifecycleStore always exposes both methods.
  const compatibleStore = store as LifecycleStore & {
    getSubjectsByEntity?: LifecycleStore['getSubjectsByEntity'];
    getSubjectByEntity?: LifecycleStore['getSubjectByEntity'];
  };
  let subjects: LifecycleSubject[] = [];
  if (compatibleStore.getSubjectsByEntity) {
    subjects = await compatibleStore.getSubjectsByEntity(requestedEntityRef);
  } else if (compatibleStore.getSubjectByEntity) {
    const legacySubject = await compatibleStore.getSubjectByEntity(
      requestedEntityRef,
    );
    subjects = legacySubject ? [legacySubject] : [];
  }
  const subject = subjects[0];
  const ambiguousSubjectMapping = subjects.length > 1;
  let syncState: LifecycleSyncState = { status: 'never' };
  if (subject && compatibleStore.getSyncState) {
    syncState = await compatibleStore.getSyncState(subject.id);
  }
  const syncDecision = await permissions.authorize(
    [{ permission: pluginLifecycleSyncRunPermission }],
    { credentials },
  );
  const canRefresh =
    syncDecision[0]?.result === AuthorizeResult.ALLOW &&
    dependencies.refresherConfigured;
  let bootstrapStatus:
    | 'not_started'
    | 'running'
    | 'completed'
    | 'failed'
    | undefined;
  if (dependencies.bootstrapKey && compatibleStore.getBootstrapStatus) {
    bootstrapStatus = await compatibleStore.getBootstrapStatus(
      dependencies.bootstrapKey,
    );
  }

  let associationRows: ChangeAssociation[] = [];
  if (stored.selectedChange) {
    associationRows = await store.getAssociations(
      stored.selectedChange.changeId,
    );
  } else if (requestedEntity && isOverlayComponent(requestedEntity)) {
    associationRows = resolveAssociations(requestedEntity);
  } else if (subject) {
    associationRows = subjectBindings(
      subject,
      compatibleStore.getSubjectBindings
        ? await compatibleStore.getSubjectBindings(subject.id)
        : [],
    );
  }
  const summaries = await summarizeAssociations(
    associationRows,
    catalog,
    credentials,
  );
  const warnings = contextWarnings(
    summaries,
    requestedEntityRef,
    requestedEntity,
    ambiguousSubjectMapping,
  );
  const subjectSummary =
    summaries.find(summary => summary.role === 'subject') ??
    entitySummary(selectedSubjectRef, 'subject', selectedSubject);
  const relatedEntities = summaries.filter(
    summary =>
      summary.entityRef !== subjectSummary.entityRef ||
      summary.role !== subjectSummary.role,
  );
  const mappingStatus =
    (ambiguousSubjectMapping ? 'incomplete' : subject?.mappingStatus) ??
    (associationRows.length > 0 ? 'complete' : 'missing');

  let overlayEntity: Entity | undefined;
  if (requestedEntity && isOverlayComponent(requestedEntity)) {
    overlayEntity = requestedEntity;
  } else if (subject) {
    overlayEntity = await catalog.getEntityByRef(subject.overlayEntityRef, {
      credentials,
    });
  }
  const delivery =
    input.asOf || input.asOfEventId
      ? undefined
      : await buildDelivery({
          subject: subjectSummary,
          summaries,
          overlayEntity,
          requestedEntity,
          changes: await store.getChangeDetails(requestedEntityRef),
          syncState,
          catalog,
          credentials,
        });

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
