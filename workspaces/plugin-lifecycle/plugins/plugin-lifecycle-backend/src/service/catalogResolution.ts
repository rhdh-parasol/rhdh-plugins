/*
 * Copyright Red Hat, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 */
import { createHash } from 'crypto';
import type { BackstageCredentials } from '@backstage/backend-plugin-api';
import {
  parseEntityRef,
  RELATION_DEPENDS_ON,
  RELATION_OWNED_BY,
  stringifyEntityRef,
  type Entity,
} from '@backstage/catalog-model';
import { InputError, NotFoundError } from '@backstage/errors';
import type { CatalogService } from '@backstage/plugin-catalog-node';
import type {
  CatalogEntitySummary,
  EntityRole,
} from '@red-hat-developer-hub/backstage-plugin-lifecycle-common';
import type { LifecycleStore } from '../database/LifecycleStore';
import type { ChangeAssociation } from '../database/types';
import { canonicalEntityRef } from './identity';

export const ANNOTATION_SOURCE = 'rhdh.io/source-entity-ref';
export const ANNOTATION_PLUGINS = 'rhdh.io/extensions-plugin-refs';
export const ANNOTATION_PACKAGES = 'rhdh.io/extensions-package-refs';

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

export function isOverlayComponent(entity: Entity): boolean {
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

function supportLabel(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  const support = recordValue(value);
  if (!support) return undefined;
  const provider =
    typeof support.provider === 'string' ? support.provider : undefined;
  const level = typeof support.level === 'string' ? support.level : undefined;
  return [provider, level].filter(Boolean).join(' · ') || undefined;
}

function entityStrings(value: unknown): string[] {
  return stringList(value).filter(Boolean);
}

export function entitySummary(
  entityRef: string,
  role: EntityRole,
  entity?: Entity,
): CatalogEntitySummary {
  const parsed = parseEntityRef(entityRef);
  const backstage = recordValue(entity?.spec?.backstage);
  const supportedVersions = [
    ...entityStrings(entity?.spec?.supportedVersions),
    ...entityStrings(backstage?.supportedVersions),
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

export function uniqueAssociations(
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

/** Builds the association set declared by one overlay Component. */
export function resolveAssociations(overlay: Entity): ChangeAssociation[] {
  const overlayRef = stringifyEntityRef(overlay);
  const sourceRefs = [
    ...relationRefs(overlay, RELATION_DEPENDS_ON),
    ...annotationRefs(overlay, ANNOTATION_SOURCE),
  ].filter(ref => ref.toLocaleLowerCase('en-US').startsWith('component:'));
  const pluginRefs = annotationRefs(overlay, ANNOTATION_PLUGINS).filter(ref =>
    ref.toLocaleLowerCase('en-US').startsWith('plugin:'),
  );
  const packageRefs = annotationRefs(overlay, ANNOTATION_PACKAGES).filter(ref =>
    ref.toLocaleLowerCase('en-US').startsWith('package:'),
  );
  return uniqueAssociations([
    { entityRef: overlayRef, role: 'subject', relationSource: 'subject' },
    { entityRef: overlayRef, role: 'overlay', relationSource: 'subject' },
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
  ]);
}

export function requireOverlayEntity(
  entityRef: string,
  entity: Entity | undefined,
): asserts entity is Entity {
  if (!entity)
    throw new NotFoundError(`Catalog entity "${entityRef}" was not found`);
  if (!isOverlayComponent(entity)) {
    throw new InputError(
      `Lifecycle changes require an rhdh-overlay-workspace Component, received ${entity.kind}`,
    );
  }
}

export async function summarizeAssociations(
  associations: ChangeAssociation[],
  catalog: CatalogService,
  credentials: BackstageCredentials,
): Promise<CatalogEntitySummary[]> {
  return Promise.all(
    associations.map(async association => {
      const entity = await catalog.getEntityByRef(association.entityRef, {
        credentials,
      });
      return entitySummary(association.entityRef, association.role, entity);
    }),
  );
}

/** Reconciles the catalog mapping for one overlay into durable storage. */
export async function reconcileOverlay(
  overlay: Entity,
  catalog: CatalogService,
  store: LifecycleStore,
  credentials: BackstageCredentials,
): Promise<void> {
  const associations = resolveAssociations(overlay);
  const overlayRef = canonicalEntityRef(stringifyEntityRef(overlay));
  const annotations = overlay.metadata.annotations ?? {};
  const checked = await Promise.all(
    associations
      .filter(association => association.role !== 'subject')
      .map(async association => ({
        association,
        exists: Boolean(
          await catalog.getEntityByRef(association.entityRef, { credentials }),
        ),
      })),
  );
  const mapping = checked
    .map(entry => entry.association)
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
  await store.upsertSubject({
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
    bindings: checked.map(entry => ({
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
