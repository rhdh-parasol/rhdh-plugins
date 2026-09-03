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

export const API_SCHEMA_VERSION = 2 as const;

const externalIdSchema = z.string().min(1).max(300);
const shortTextSchema = z.string().min(1).max(300);
const summarySchema = z.string().min(1).max(4000);
const urlSchema = z.string().url().max(2048);
const entityRefSchema = z.string().min(1).max(512);

export const lifecyclePhaseSchema = z.enum([
  'intent',
  'implementation',
  'build',
  'verification',
  'publication',
]);

export const lifecycleStateSchema = z.enum([
  'pending',
  'running',
  'blocked',
  'ready_for_human',
  'failed',
  'succeeded',
  'superseded',
]);

export const entityRoleSchema = z.enum([
  'subject',
  'source',
  'overlay',
  'extension-plugin',
  'package',
]);

export const lifecycleTargetSchema = z
  .object({
    rhdhVersion: shortTextSchema.optional(),
    backstageVersion: shortTextSchema.optional(),
    pluginVersion: shortTextSchema.optional(),
  })
  .strict();

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

export const ciRunSchema = z
  .object({
    provider: shortTextSchema,
    repository: shortTextSchema.optional(),
    workflow: shortTextSchema,
    workflowId: externalIdSchema.optional(),
    workflowFile: shortTextSchema.optional(),
    runId: externalIdSchema,
    /** GitHub run number. `attempt` is accepted for fixtures written by v1. */
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
    if (!run.runNumber && !run.attempt) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['runNumber'],
        message: 'A CI run requires runNumber',
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

export const verificationSchema = z
  .object({
    method: z.enum(['playwright', 'smoke', 'manual', 'other']),
    state: lifecycleStateSchema,
    summary: summarySchema,
    url: urlSchema.optional(),
    digest: z.string().min(1).max(512).optional(),
  })
  .strict();

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

export const agentAttemptSchema = z
  .object({
    agent: shortTextSchema,
    state: lifecycleStateSchema,
    summary: summarySchema,
    sessionUrl: urlSchema.optional(),
    evidenceUrl: urlSchema.optional(),
  })
  .strict();

export const changeCreatedEventSchema = z
  .object({
    kind: z.literal('change.created'),
    title: shortTextSchema,
    summary: z.string().max(4000).optional(),
    target: lifecycleTargetSchema.optional(),
    initialReferences: z.array(lifecycleReferenceSchema).default([]),
  })
  .strict();

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

export const referenceLinkedEventSchema = z
  .object({
    kind: z.literal('reference.linked'),
    reference: lifecycleReferenceSchema,
  })
  .strict();

export const ciRunRecordedEventSchema = z
  .object({
    kind: z.literal('ci.run.recorded'),
    run: ciRunSchema,
  })
  .strict();

export const verificationRecordedEventSchema = z
  .object({
    kind: z.literal('verification.recorded'),
    verification: verificationSchema,
  })
  .strict();

export const artifactRecordedEventSchema = z
  .object({
    kind: z.literal('artifact.recorded'),
    artifact: artifactSchema,
  })
  .strict();

export const agentAttemptRecordedEventSchema = z
  .object({
    kind: z.literal('agent.attempt.recorded'),
    attempt: agentAttemptSchema,
  })
  .strict();

export const changeSupersededEventSchema = z
  .object({
    kind: z.literal('change.superseded'),
    reason: summarySchema,
    replacementChangeId: z.string().uuid().optional(),
  })
  .strict();

export const recordableLifecycleEventSchema = z.discriminatedUnion('kind', [
  phaseUpdatedEventSchema,
  referenceLinkedEventSchema,
  ciRunRecordedEventSchema,
  verificationRecordedEventSchema,
  artifactRecordedEventSchema,
  agentAttemptRecordedEventSchema,
  changeSupersededEventSchema,
]);

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

export const lifecycleSuccessfulPublicationSchema = z
  .object({
    change: lifecycleChangeSummarySchema,
    run: ciRunSchema.optional(),
    artifacts: z.array(artifactSchema),
  })
  .strict();

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

export const createChangeOutputSchema = z
  .object({
    change: lifecycleChangeSummarySchema,
    projection: lifecycleProjectionSchema,
  })
  .strict();

export const recordEventInputSchema = z
  .object({
    eventId: z.string().min(1).max(200),
    changeId: z.string().uuid(),
    occurredAt: z.string().datetime(),
    producer: z.string().min(1).max(200),
    event: recordableLifecycleEventSchema,
  })
  .strict();

export const recordEventOutputSchema = z
  .object({
    event: lifecycleEventSchema,
    projection: lifecycleProjectionSchema,
  })
  .strict();

export const getContextInputSchema = z
  .object({
    entityRef: entityRefSchema,
    changeId: z.string().uuid().optional(),
    asOf: z.string().datetime().optional(),
    asOfEventId: z.string().regex(/^\d+$/).optional(),
    eventLimit: z.number().int().min(1).max(500).default(100),
  })
  .strict();

export const refreshInputSchema = z
  .object({ entityRef: entityRefSchema })
  .strict();
export const getContextActionInputSchema = getContextInputSchema.extend({
  refreshPolicy: z.enum(['if_stale', 'never']).default('if_stale'),
});

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

export const deliveryStatusSchema = z.enum([
  'stable',
  'attention_required',
  'in_progress',
  'ready_to_test',
  'ready_to_merge',
  'unknown',
]);

const deliveryBuildSchema = z
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

const deliveryCandidateSchema = z
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

const deliveryPackageSchema = z
  .object({
    entityRef: entityRefSchema,
    packageName: z.string().optional(),
    version: z.string().optional(),
    ociReference: z.string().optional(),
    support: z.string().optional(),
    supportedVersions: z.array(z.string()),
    evidence: z.literal('catalog_reported'),
  })
  .strict();

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

export type DeliveryStatus = z.infer<typeof deliveryStatusSchema>;
export type DeliveryBuild = z.infer<typeof deliveryBuildSchema>;
export type DeliveryCandidate = z.infer<typeof deliveryCandidateSchema>;
export type DeliveryPackage = z.infer<typeof deliveryPackageSchema>;
export type Delivery = z.infer<typeof deliverySchema>;

export const lifecycleWarningSchema = z
  .object({
    code: z.string().min(1).max(100),
    message: z.string().min(1).max(1000),
    entityRef: entityRefSchema.optional(),
  })
  .strict();

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

export const getContextOutputSchema = lifecycleContextSchema;
export const refreshOutputSchema = lifecycleContextSchema;

export type LifecyclePhase = z.infer<typeof lifecyclePhaseSchema>;
export type LifecycleState = z.infer<typeof lifecycleStateSchema>;
export type EntityRole = z.infer<typeof entityRoleSchema>;
export type LifecycleTarget = z.infer<typeof lifecycleTargetSchema>;
export type LifecycleReference = z.infer<typeof lifecycleReferenceSchema>;
export type CiRun = z.infer<typeof ciRunSchema>;
export type Verification = z.infer<typeof verificationSchema>;
export type Artifact = z.infer<typeof artifactSchema>;
export type AgentAttempt = z.infer<typeof agentAttemptSchema>;
export type LifecycleEventPayload = z.infer<typeof lifecycleEventPayloadSchema>;
export type RecordableLifecycleEvent = z.infer<
  typeof recordableLifecycleEventSchema
>;
export type LifecycleEvent = z.infer<typeof lifecycleEventSchema>;
export type LifecycleProjection = z.infer<typeof lifecycleProjectionSchema>;
export type LifecycleChangeSummary = z.infer<
  typeof lifecycleChangeSummarySchema
>;
export type LifecycleSuccessfulPublication = z.infer<
  typeof lifecycleSuccessfulPublicationSchema
>;
export type CreateChangeInput = z.infer<typeof createChangeInputSchema>;
export type CreateChangeOutput = z.infer<typeof createChangeOutputSchema>;
export type RecordEventInput = z.infer<typeof recordEventInputSchema>;
export type RecordEventOutput = z.infer<typeof recordEventOutputSchema>;
export type GetContextInput = z.infer<typeof getContextInputSchema>;
export type RefreshInput = z.infer<typeof refreshInputSchema>;
export type GetContextActionInput = z.infer<typeof getContextActionInputSchema>;
export type CatalogEntitySummary = z.infer<typeof catalogEntitySummarySchema>;
export type LifecycleContext = z.infer<typeof lifecycleContextSchema>;
