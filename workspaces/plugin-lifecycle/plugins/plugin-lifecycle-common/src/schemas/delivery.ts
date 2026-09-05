/*
 * Copyright Red Hat, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 */
import { z } from 'zod/v3';
import {
  entityRefSchema,
  entityRoleSchema,
  externalIdSchema,
  shortTextSchema,
  urlSchema,
} from './primitives';

/** @public */
export const catalogEntitySummarySchema = z
  .object({
    entityRef: entityRefSchema,
    role: entityRoleSchema,
    catalogStatus: z.enum(['available', 'missing']),
    kind: z.string(),
    namespace: z.string(),
    name: z.string(),
    title: z.string().optional(),
    description: z.string().optional(),
    type: z.string().optional(),
    ownerRef: entityRefSchema.optional(),
    packageName: z.string().optional(),
    version: z.string().optional(),
    dynamicArtifact: z.string().optional(),
    supportedVersions: z.array(z.string()).default([]),
    support: z.string().optional(),
  })
  .strict();

/** @public */
export const deliveryStatusSchema = z.enum([
  'stable',
  'attention_required',
  'in_progress',
  'ready_to_test',
  'ready_to_merge',
  'unknown',
]);

/** @public */
export const deliveryBuildSchema = z
  .object({
    runId: externalIdSchema,
    runNumber: z.number().int().positive().optional(),
    runAttempt: z.number().int().positive().optional(),
    status: z.enum(['queued', 'in_progress', 'completed']),
    conclusion: z.string().optional(),
    repository: z.string().optional(),
    branch: z.string().optional(),
    commitSha: z.string().optional(),
    commitUrl: urlSchema.optional(),
    jobName: z.string().optional(),
    url: urlSchema.optional(),
    updatedAt: z.string().datetime().optional(),
  })
  .strict();

/** @public */
export const deliveryCandidateSchema = z
  .object({
    changeId: z.string().uuid(),
    title: shortTextSchema,
    author: shortTextSchema.optional(),
    pullRequestNumber: z.number().int().positive().optional(),
    pullRequestUrl: urlSchema.optional(),
    sourceRevision: z.string().optional(),
    sourceUrl: urlSchema.optional(),
    updatedAt: z.string().datetime(),
    publishStatus: z.enum([
      'unknown',
      'pending',
      'running',
      'success',
      'failure',
    ]),
    publishUrl: urlSchema.optional(),
    smokeTestStatus: z.enum([
      'not_run',
      'pending',
      'running',
      'success',
      'failure',
    ]),
    smokeTestUrl: urlSchema.optional(),
    candidateImages: z
      .array(
        z
          .object({
            reference: z.string().min(1).max(2048),
            packageEntityRef: entityRefSchema.optional(),
            version: z.string().optional(),
            observedAt: z.string().datetime(),
          })
          .strict(),
      )
      .default([]),
    blocker: z.string().optional(),
    nextAction: z.string().optional(),
    nextActionUrl: urlSchema.optional(),
    nextActionLabel: shortTextSchema.optional(),
  })
  .strict();

/** @public */
export const deliveryPackageSchema = z
  .object({
    entityRef: entityRefSchema,
    pluginEntityRef: entityRefSchema.optional(),
    packageName: z.string().optional(),
    version: z.string().optional(),
    ociReference: z.string().optional(),
    support: z.string().optional(),
    supportedVersions: z.array(z.string()),
    evidence: z.literal('catalog_reported'),
  })
  .strict();

/** @public */
export const deliverySchema = z
  .object({
    status: deliveryStatusSchema,
    statusReason: z.string(),
    ownerRef: entityRefSchema.optional(),
    workspace: z.string(),
    releasedPackages: z.array(deliveryPackageSchema),
    activeCandidates: z.array(deliveryCandidateSchema),
    mainline: z
      .object({
        latestBuild: deliveryBuildSchema.optional(),
        latestSuccessfulBuild: deliveryBuildSchema.optional(),
      })
      .strict(),
    nextAction: z.string().optional(),
    nextActionUrl: urlSchema.optional(),
    nextActionLabel: shortTextSchema.optional(),
    freshness: z
      .object({
        syncStatus: z.string(),
        lastSuccessAt: z.string().datetime().optional(),
        stale: z.boolean(),
      })
      .strict(),
  })
  .strict();

/** @public */
export type DeliveryStatus = z.infer<typeof deliveryStatusSchema>;
/** @public */
export type DeliveryBuild = z.infer<typeof deliveryBuildSchema>;
/** @public */
export type DeliveryCandidate = z.infer<typeof deliveryCandidateSchema>;
/** @public */
export type DeliveryPackage = z.infer<typeof deliveryPackageSchema>;
/** @public */
export type Delivery = z.infer<typeof deliverySchema>;
