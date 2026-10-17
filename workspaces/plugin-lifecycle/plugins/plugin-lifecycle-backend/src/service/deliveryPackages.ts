/*
 * Copyright Red Hat, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 */
import { stringifyEntityRef, type Entity } from '@backstage/catalog-model';
import type { BackstageCredentials } from '@backstage/backend-plugin-api';
import type { CatalogService } from '@backstage/plugin-catalog-node';
import type {
  CatalogEntitySummary,
  DeliveryPackage,
} from '@red-hat-developer-hub/backstage-plugin-lifecycle-common';
import { canonicalEntityRef } from './identity';

function packageRefsForPlugin(entity: Entity): Set<string> {
  const namespace = entity.metadata.namespace ?? 'default';
  const values = Array.isArray(entity.spec?.packages)
    ? entity.spec.packages
    : [];
  return new Set(
    values
      .map(value => (typeof value === 'string' ? value : undefined))
      .filter((value): value is string => Boolean(value))
      .map(value =>
        canonicalEntityRef(
          value.includes(':') ? value : `package:${namespace}/${value}`,
        ),
      ),
  );
}

export interface ReleasedPackageInput {
  summaries: CatalogEntitySummary[];
  requestedEntity?: Entity;
  catalog: CatalogService;
  credentials: BackstageCredentials;
}

/** Resolves Packages through exact Extension Plugin membership. */
export async function releasedPackages({
  summaries,
  requestedEntity,
  catalog,
  credentials,
}: ReleasedPackageInput): Promise<DeliveryPackage[]> {
  const packageRefsByPlugin = new Map<string, Set<string>>();
  for (const summary of summaries.filter(
    candidate =>
      candidate.role === 'extension-plugin' &&
      candidate.catalogStatus === 'available',
  )) {
    const plugin = await catalog.getEntityByRef(summary.entityRef, {
      credentials,
    });
    if (plugin)
      packageRefsByPlugin.set(summary.entityRef, packageRefsForPlugin(plugin));
  }

  const requestedPluginRef =
    requestedEntity?.kind.toLocaleLowerCase('en-US') === 'plugin'
      ? canonicalEntityRef(stringifyEntityRef(requestedEntity))
      : undefined;
  if (requestedPluginRef && requestedEntity) {
    packageRefsByPlugin.set(
      requestedPluginRef,
      packageRefsForPlugin(requestedEntity),
    );
  }
  const selectedPackageRefs = requestedPluginRef
    ? packageRefsByPlugin.get(requestedPluginRef) ?? new Set<string>()
    : new Set([...packageRefsByPlugin.values()].flatMap(refs => [...refs]));

  return summaries
    .filter(
      summary =>
        summary.role === 'package' &&
        summary.catalogStatus === 'available' &&
        selectedPackageRefs.has(summary.entityRef),
    )
    .map(pkg => ({
      entityRef: pkg.entityRef,
      pluginEntityRef: [...packageRefsByPlugin.entries()].find(([, refs]) =>
        refs.has(pkg.entityRef),
      )?.[0],
      packageName: pkg.packageName,
      version: pkg.version,
      ociReference: pkg.dynamicArtifact,
      support: pkg.support,
      supportedVersions: pkg.supportedVersions,
      evidence: 'catalog_reported' as const,
    }));
}
