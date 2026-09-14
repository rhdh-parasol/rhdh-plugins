/*
 * Copyright Red Hat, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 */
import type { BackstageCredentials } from '@backstage/backend-plugin-api';
import { parseEntityRef, stringifyEntityRef } from '@backstage/catalog-model';
import { InputError, NotAllowedError } from '@backstage/errors';

/** Converts the flexible Catalog reference syntax into one stable key. */
export function canonicalEntityRef(entityRef: string): string {
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

/** Returns a stable actor label for event attribution. */
export function actorRef(credentials: BackstageCredentials): string {
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

/** The POC accepts writes only from authenticated human OAuth identities. */
export function requireHumanIdentity(credentials: BackstageCredentials): void {
  const principal = credentials.principal as { type?: string };
  if (principal.type !== 'user') {
    throw new NotAllowedError(
      'Plugin Lifecycle requires authenticated human credentials',
    );
  }
}
