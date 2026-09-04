/*
 * Copyright Red Hat, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 */
import { z } from 'zod/v3';

/** @public */
export const API_SCHEMA_VERSION = 2 as const;

export const externalIdSchema = z.string().min(1).max(300);
export const shortTextSchema = z.string().min(1).max(300);
export const summarySchema = z.string().min(1).max(4000);
export const urlSchema = z.string().url().max(2048);
export const entityRefSchema = z.string().min(1).max(512);

/** @public */
export const lifecyclePhaseSchema = z.enum([
  'intent',
  'implementation',
  'build',
  'verification',
  'publication',
]);

/** @public */
export const lifecycleStateSchema = z.enum([
  'pending',
  'running',
  'blocked',
  'ready_for_human',
  'failed',
  'succeeded',
  'superseded',
]);

/** @public */
export const entityRoleSchema = z.enum([
  'subject',
  'source',
  'overlay',
  'extension-plugin',
  'package',
]);

/** @public */
export const lifecycleTargetSchema = z
  .object({
    rhdhVersion: shortTextSchema.optional(),
    backstageVersion: shortTextSchema.optional(),
    pluginVersion: shortTextSchema.optional(),
  })
  .strict();

/** @public */
export const lifecycleReferenceSchema = z
  .object({
    type: z.enum([
      'jira',
      'pull_request',
      'issue',
      'source',
      'documentation',
      'workflow',
      'workflow-job',
      'artifact',
      'catalog-entity',
      'other',
    ]),
    externalId: externalIdSchema.optional(),
    entityRef: entityRefSchema.optional(),
    title: shortTextSchema,
    url: urlSchema,
    author: shortTextSchema.optional(),
    updatedAt: z.string().datetime().optional(),
  })
  .strict();
