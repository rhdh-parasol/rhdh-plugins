/*
 * Copyright Red Hat, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 */
import type { BackstageCredentials } from '@backstage/backend-plugin-api';
import type { Entity } from '@backstage/catalog-model';
import type { CatalogService } from '@backstage/plugin-catalog-node';

/**
 * Reads the catalog using cursor pagination. A bounded page size prevents the
 * lifecycle collector from silently dropping subjects once an instance grows
 * beyond the old single-page limit.
 */
export async function queryAllCatalogEntities(
  catalog: CatalogService,
  request: Parameters<CatalogService['queryEntities']>[0],
  credentials: BackstageCredentials,
  maxItems = 10_000,
): Promise<Entity[]> {
  const entities: Entity[] = [];
  let response = await catalog.queryEntities(
    { ...(request ?? {}), limit: Math.min(request?.limit ?? 500, 500) },
    { credentials },
  );
  entities.push(...response.items);
  while (response.pageInfo?.nextCursor && entities.length < maxItems) {
    response = await catalog.queryEntities(
      { cursor: response.pageInfo.nextCursor },
      { credentials },
    );
    entities.push(...response.items);
  }
  return entities.slice(0, maxItems);
}
