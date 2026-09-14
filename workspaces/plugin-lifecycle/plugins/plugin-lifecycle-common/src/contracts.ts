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
import { z } from 'zod/v3';
import {
  API_SCHEMA_VERSION,
  entityRefSchema,
  entityRoleSchema,
  externalIdSchema,
  lifecyclePhaseSchema,
  lifecycleReferenceSchema,
  lifecycleStateSchema,
  lifecycleTargetSchema,
  shortTextSchema,
  summarySchema,
  urlSchema,
} from './schemas/primitives';
import { catalogEntitySummarySchema, deliverySchema } from './schemas/delivery';

export {
  API_SCHEMA_VERSION,
  entityRoleSchema,
  lifecyclePhaseSchema,
  lifecycleReferenceSchema,
  lifecycleStateSchema,
  lifecycleTargetSchema,
} from './schemas/primitives';
export {
  catalogEntitySummarySchema,
  deliveryBuildSchema,
  deliveryCandidateSchema,
  deliveryPackageSchema,
  deliverySchema,
  deliveryStatusSchema,
} from './schemas/delivery';
export type {
  Delivery,
  DeliveryBuild,
  DeliveryCandidate,
  DeliveryPackage,
  DeliveryStatus,
} from './schemas/delivery';

/** @public */
export const ciRunSchema = z
  .object({
    provider: shortTextSchema,
    repository: shortTextSchema.optional(),
    workflow: shortTextSchema,
    workflowId: externalIdSchema.optional(),
    workflowFile: shortTextSchema.optional(),
    runId: externalIdSchema,
    /** GitHub run number. Commit-status observations use runAttempt instead. */
    runNumber: z.number().int().positive().optional(),
    attempt: z.number().int().positive().optional(),
    runAttempt: z.number().int().positive().optional(),
    jobId: externalIdSchema.optional(),
    jobName: shortTextSchema.optional(),
    workspace: shortTextSchema.optional(),
    eventName: shortTextSchema.optional(),
    branch: shortTextSchema.optional(),
    pullRequestNumber: z.number().int().positive().optional(),
    overlayCommitSha: z.string().min(7).max(128).optional(),
    sourceRepository: shortTextSchema.optional(),
    sourceCommitSha: z.string().min(7).max(128).optional(),
    commitSha: z.string().min(7).max(128).optional(),
    status: z.enum(['queued', 'in_progress', 'completed']),
    conclusion: z
      .enum([
        'success',
        'failure',
        'cancelled',
        'skipped',
        'timed_out',
        'neutral',
        'action_required',
      ])
      .optional(),
    startedAt: z.string().datetime().optional(),
    completedAt: z.string().datetime().optional(),
    updatedAt: z.string().datetime().optional(),
    url: urlSchema.optional(),
    winning: z.boolean().default(false),
    fixture: z.boolean().default(false),
  })
  .strict()
  .superRefine((run, context) => {
    if (!run.runNumber && !run.runAttempt && !run.attempt) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['runNumber'],
        message: 'A CI run requires runNumber or runAttempt',
      });
    }
    if (run.status === 'completed' && !run.conclusion) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['conclusion'],
        message: 'A completed CI run requires a conclusion',
      });
    }
    if (run.status !== 'completed' && run.conclusion) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['conclusion'],
        message: 'Only a completed CI run may have a conclusion',
      });
    }
    if (
      run.winning &&
      (run.status !== 'completed' || run.conclusion !== 'success')
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['winning'],
        message: 'A winning CI run must be completed successfully',
      });
    }
  });

/** @public */
export const verificationSchema = z
  .object({
    method: z.enum(['playwright', 'smoke', 'manual', 'other']),
    state: lifecycleStateSchema,
    summary: summarySchema,
    url: urlSchema.optional(),
    digest: z.string().min(1).max(512).optional(),
  })
  .strict();

/** @public */
export const artifactSchema = z
  .object({
    artifactType: z.enum([
      'npm',
      'oci',
      'sbom',
      'report',
      'recording',
      'other',
    ]),
    packageEntityRef: entityRefSchema.optional(),
    name: shortTextSchema.optional(),
    version: shortTextSchema.optional(),
    reference: z.string().min(1).max(2048),
    url: urlSchema.optional(),
    digest: z
      .string()
      .regex(/^sha256:[a-f0-9]{64}$/)
      .optional(),
    runId: externalIdSchema.optional(),
    jobId: externalIdSchema.optional(),
  })
  .strict();

/** @public */
export const agentAttemptSchema = z
  .object({
    agent: shortTextSchema,
    state: lifecycleStateSchema,
    summary: summarySchema,
    sessionUrl: urlSchema.optional(),
    evidenceUrl: urlSchema.optional(),
  })
  .strict();

/** @public */
export const changeCreatedEventSchema = z
  .object({
    kind: z.literal('change.created'),
    title: shortTextSchema,
    summary: z.string().max(4000).optional(),
    target: lifecycleTargetSchema.optional(),
    initialReferences: z.array(lifecycleReferenceSchema).default([]),
  })
  .strict();

/** @public */
export const phaseUpdatedEventSchema = z
  .object({
    kind: z.literal('phase.updated'),
    phase: lifecyclePhaseSchema,
    state: lifecycleStateSchema,
    summary: summarySchema,
    blocker: summarySchema.optional(),
    ownerRef: entityRefSchema.optional(),
    evidenceUrl: urlSchema.optional(),
  })
  .strict();

/** @public */
export const referenceLinkedEventSchema = z
  .object({
    kind: z.literal('reference.linked'),
    reference: lifecycleReferenceSchema,
  })
  .strict();

/** @public */
export const ciRunRecordedEventSchema = z
  .object({
    kind: z.literal('ci.run.recorded'),
    run: ciRunSchema,
  })
  .strict();

/** @public */
export const verificationRecordedEventSchema = z
  .object({
    kind: z.literal('verification.recorded'),
    verification: verificationSchema,
  })
  .strict();

/** @public */
export const artifactRecordedEventSchema = z
  .object({
    kind: z.literal('artifact.recorded'),
    artifact: artifactSchema,
  })
  .strict();

/** @public */
export const agentAttemptRecordedEventSchema = z
  .object({
    kind: z.literal('agent.attempt.recorded'),
    attempt: agentAttemptSchema,
  })
  .strict();

/** @public */
export const changeSupersededEventSchema = z
  .object({
    kind: z.literal('change.superseded'),
    reason: summarySchema,
    replacementChangeId: z.string().uuid().optional(),
  })
  .strict();

/** @public */
export const recordableLifecycleEventSchema = z.discriminatedUnion('kind', [
  phaseUpdatedEventSchema,
  referenceLinkedEventSchema,
  ciRunRecordedEventSchema,
  verificationRecordedEventSchema,
  artifactRecordedEventSchema,
  agentAttemptRecordedEventSchema,
  changeSupersededEventSchema,
]);

/** @public */
export const lifecycleEventPayloadSchema = z.discriminatedUnion('kind', [
  changeCreatedEventSchema,
  phaseUpdatedEventSchema,
  referenceLinkedEventSchema,
  ciRunRecordedEventSchema,
  verificationRecordedEventSchema,
  artifactRecordedEventSchema,
  agentAttemptRecordedEventSchema,
  changeSupersededEventSchema,
]);

/** @public */
export const lifecycleEventSchema = z
  .object({
    eventId: z.string().min(1).max(200),
    eventCursor: z.string().regex(/^\d+$/).optional(),
    changeId: z.string().uuid(),
    schemaVersion: z.literal(API_SCHEMA_VERSION),
    occurredAt: z.string().datetime(),
    ingestedAt: z.string().datetime(),
    actorRef: entityRefSchema,
    producer: z.string().min(1).max(200),
    payload: lifecycleEventPayloadSchema,
  })
  .strict();

/** @public */
export const lifecycleProjectionSchema = z
  .object({
    phase: lifecyclePhaseSchema,
    state: lifecycleStateSchema,
    summary: z.string(),
    blocker: z.string().optional(),
    ownerRef: z.string().optional(),
    target: lifecycleTargetSchema.optional(),
    references: z.array(lifecycleReferenceSchema),
    ciRuns: z.array(ciRunSchema),
    winningRun: ciRunSchema.optional(),
    verifications: z.array(verificationSchema),
    artifacts: z.array(artifactSchema),
    agentAttempts: z.array(agentAttemptSchema),
    supersededBy: z.string().uuid().optional(),
    phaseStates: z
      .array(
        z
          .object({
            phase: lifecyclePhaseSchema,
            state: lifecycleStateSchema,
            summary: z.string(),
            blocker: z.string().optional(),
            evidenceUrl: urlSchema.optional(),
            updatedAt: z.string().datetime(),
          })
          .strict(),
      )
      .optional(),
    updatedAt: z.string().datetime(),
  })
  .strict();

/** @public */
export const lifecycleChangeSummarySchema = z
  .object({
    changeId: z.string().uuid(),
    subjectEntityRef: entityRefSchema,
    origin: z.enum(['action', 'github-actions', 'fixture']).default('action'),
    externalChangeKey: z.string().max(1000).optional(),
    scope: z.enum(['pull_request', 'branch', 'manual']).optional(),
    externalStatus: z
      .enum(['open', 'merged', 'closed', 'published'])
      .optional(),
    lastOccurredAt: z.string().datetime().optional(),
    title: shortTextSchema,
    summary: z.string().optional(),
    currentPhase: lifecyclePhaseSchema,
    currentState: lifecycleStateSchema,
    createdBy: entityRefSchema,
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();

/** @public */
export const lifecycleSuccessfulPublicationSchema = z
  .object({
    change: lifecycleChangeSummarySchema,
    run: ciRunSchema.optional(),
    artifacts: z.array(artifactSchema),
  })
  .strict();

/** @public */
export const createChangeInputSchema = z
  .object({
    requestId: z.string().min(1).max(200),
    subjectEntityRef: entityRefSchema,
    title: shortTextSchema,
    summary: z.string().max(4000).optional(),
    target: lifecycleTargetSchema.optional(),
    initialReferences: z.array(lifecycleReferenceSchema).max(20).default([]),
  })
  .strict();

/** @public */
export const createChangeOutputSchema = z
  .object({
    change: lifecycleChangeSummarySchema,
    projection: lifecycleProjectionSchema,
  })
  .strict();

/** @public */
export const recordEventInputSchema = z
  .object({
    eventId: z.string().min(1).max(200),
    changeId: z.string().uuid(),
    occurredAt: z.string().datetime(),
    producer: z.string().min(1).max(200),
    event: recordableLifecycleEventSchema,
  })
  .strict();

/** @public */
export const recordEventOutputSchema = z
  .object({
    event: lifecycleEventSchema,
    projection: lifecycleProjectionSchema,
  })
  .strict();

/** @public */
export const getContextInputSchema = z
  .object({
    entityRef: entityRefSchema,
    changeId: z.string().uuid().optional(),
    asOf: z.string().datetime().optional(),
    asOfEventId: z.string().regex(/^\d+$/).optional(),
    eventLimit: z.number().int().min(1).max(500).default(100),
  })
  .strict();

/** @public */
export const refreshInputSchema = z
  .object({ entityRef: entityRefSchema })
  .strict();
/** @public */
export const getContextActionInputSchema = getContextInputSchema.extend({
  refreshPolicy: z.enum(['if_stale', 'never']).default('if_stale'),
});

/** @public */
export const lifecycleWarningSchema = z
  .object({
    code: z.string().min(1).max(100),
    message: z.string().min(1).max(1000),
    entityRef: entityRefSchema.optional(),
  })
  .strict();

/** @public */
export const lifecycleContextSchema = z
  .object({
    schemaVersion: z.literal(API_SCHEMA_VERSION),
    requestedEntityRef: entityRefSchema,
    subject: catalogEntitySummarySchema,
    relatedEntities: z.array(catalogEntitySummarySchema),
    warnings: z.array(lifecycleWarningSchema),
    changes: z.array(lifecycleChangeSummarySchema),
    selectedChange: lifecycleChangeSummarySchema.optional(),
    projection: lifecycleProjectionSchema.optional(),
    lastSuccessfulPublication: lifecycleSuccessfulPublicationSchema.optional(),
    events: z.array(lifecycleEventSchema),
    delivery: deliverySchema.optional(),
    asOf: z.string().datetime().optional(),
    asOfEventId: z.string().regex(/^\d+$/).optional(),
    resolution: z
      .object({
        requestedEntityRef: entityRefSchema,
        canonicalSubjectRef: entityRefSchema,
        requestedEntityRole: entityRoleSchema,
        mappingStatus: z.enum(['complete', 'incomplete', 'missing']),
      })
      .strict()
      .optional(),
    sync: z
      .object({
        status: z.enum([
          'never',
          'pending',
          'prioritized',
          'running',
          'succeeded',
          'empty',
          'failed',
          'rate_limited',
        ]),
        bootstrapStatus: z
          .enum(['not_started', 'running', 'completed', 'failed'])
          .optional(),
        refreshAttempted: z.boolean().default(false),
        stale: z.boolean().default(true),
        lastAttemptAt: z.string().datetime().optional(),
        lastSuccessAt: z.string().datetime().optional(),
        errorSummary: z.string().optional(),
        canRefresh: z.boolean().default(false),
      })
      .strict()
      .optional(),
  })
  .strict();

/** @public */
export const getContextOutputSchema = lifecycleContextSchema;
/** @public */
export const refreshOutputSchema = lifecycleContextSchema;

/** @public */
export type LifecyclePhase = z.infer<typeof lifecyclePhaseSchema>;
/** @public */
export type LifecycleState = z.infer<typeof lifecycleStateSchema>;
/** @public */
export type EntityRole = z.infer<typeof entityRoleSchema>;
/** @public */
export type LifecycleTarget = z.infer<typeof lifecycleTargetSchema>;
/** @public */
export type LifecycleReference = z.infer<typeof lifecycleReferenceSchema>;
/** @public */
export type CiRun = z.infer<typeof ciRunSchema>;
/** @public */
export type Verification = z.infer<typeof verificationSchema>;
/** @public */
export type Artifact = z.infer<typeof artifactSchema>;
/** @public */
export type AgentAttempt = z.infer<typeof agentAttemptSchema>;
/** @public */
export type LifecycleEventPayload = z.infer<typeof lifecycleEventPayloadSchema>;
/** @public */
export type RecordableLifecycleEvent = z.infer<
  typeof recordableLifecycleEventSchema
>;
/** @public */
export type LifecycleEvent = z.infer<typeof lifecycleEventSchema>;
/** @public */
export type LifecycleProjection = z.infer<typeof lifecycleProjectionSchema>;
/** @public */
export type LifecycleChangeSummary = z.infer<
  typeof lifecycleChangeSummarySchema
>;
/** @public */
export type LifecycleSuccessfulPublication = z.infer<
  typeof lifecycleSuccessfulPublicationSchema
>;
/** @public */
export type CreateChangeInput = z.infer<typeof createChangeInputSchema>;
/** @public */
export type CreateChangeOutput = z.infer<typeof createChangeOutputSchema>;
/** @public */
export type RecordEventInput = z.infer<typeof recordEventInputSchema>;
/** @public */
export type RecordEventOutput = z.infer<typeof recordEventOutputSchema>;
/** @public */
export type GetContextInput = z.infer<typeof getContextInputSchema>;
/** @public */
export type RefreshInput = z.infer<typeof refreshInputSchema>;
/** @public */
export type GetContextActionInput = z.infer<typeof getContextActionInputSchema>;
/** @public */
export type CatalogEntitySummary = z.infer<typeof catalogEntitySummarySchema>;
/** @public */
export type LifecycleContext = z.infer<typeof lifecycleContextSchema>;
