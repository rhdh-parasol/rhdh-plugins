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
import {
  type LifecycleEvent,
  type LifecycleProjection,
  lifecycleProjectionSchema,
} from '@red-hat-developer-hub/backstage-plugin-lifecycle-common';

function initialProjection(at: string): LifecycleProjection {
  return {
    phase: 'intent',
    state: 'pending',
    summary: '',
    references: [],
    ciRuns: [],
    verifications: [],
    artifacts: [],
    agentAttempts: [],
    phaseStates: [],
    updatedAt: at,
  };
}

function mergeReferences(
  existing: LifecycleProjection['references'],
  incoming: LifecycleProjection['references'],
): LifecycleProjection['references'] {
  return [
    ...existing,
    ...incoming.filter(
      candidate =>
        !existing.some(
          reference =>
            reference.type === candidate.type &&
            (reference.externalId ?? reference.url) ===
              (candidate.externalId ?? candidate.url),
        ),
    ),
  ];
}

/** @public */
export function reduceLifecycleEvents(
  events: LifecycleEvent[],
): LifecycleProjection {
  const firstTimestamp = events[0]?.occurredAt ?? new Date(0).toISOString();
  let projection = initialProjection(firstTimestamp);

  for (const [index, envelope] of events.entries()) {
    const { payload } = envelope;
    switch (payload.kind) {
      case 'change.created':
        projection = {
          ...projection,
          // Older collectors recorded creation at ingestion time. If such an
          // event sorts after real external evidence, it must not replace the
          // more useful current lifecycle summary.
          summary:
            index === 0 || !projection.summary
              ? payload.summary ?? payload.title
              : projection.summary,
          target: payload.target,
          references: mergeReferences(
            projection.references,
            payload.initialReferences,
          ),
        };
        break;
      case 'phase.updated': {
        const phaseStates = (projection.phaseStates ?? []).filter(
          entry => entry.phase !== payload.phase,
        );
        projection = {
          ...projection,
          phase: payload.phase,
          state: payload.state,
          summary: payload.summary,
          blocker: payload.blocker,
          ownerRef: payload.ownerRef ?? projection.ownerRef,
          phaseStates: [
            ...phaseStates,
            {
              phase: payload.phase,
              state: payload.state,
              summary: payload.summary,
              blocker: payload.blocker,
              evidenceUrl: payload.evidenceUrl,
              updatedAt: envelope.occurredAt,
            },
          ],
        };
        break;
      }
      case 'reference.linked': {
        const key = `${payload.reference.type}:${
          payload.reference.externalId ?? payload.reference.url
        }`;
        const references = projection.references.filter(
          reference =>
            `${reference.type}:${reference.externalId ?? reference.url}` !==
            key,
        );
        projection = {
          ...projection,
          references: [...references, payload.reference],
        };
        break;
      }
      case 'ci.run.recorded': {
        const runKey = [
          payload.run.provider,
          payload.run.repository ?? '',
          payload.run.runId,
          payload.run.runAttempt ??
            payload.run.runNumber ??
            payload.run.attempt,
          payload.run.jobId ?? '',
        ].join(':');
        const ciRuns = projection.ciRuns.filter(
          run =>
            [
              run.provider,
              run.repository ?? '',
              run.runId,
              run.runAttempt ?? run.runNumber ?? run.attempt,
              run.jobId ?? '',
            ].join(':') !== runKey,
        );
        let winningRun = projection.winningRun;
        if (payload.run.winning) {
          winningRun = payload.run;
        } else if (
          winningRun &&
          [
            winningRun.provider,
            winningRun.repository ?? '',
            winningRun.runId,
            winningRun.runAttempt ?? winningRun.runNumber ?? winningRun.attempt,
            winningRun.jobId ?? '',
          ].join(':') === runKey
        ) {
          winningRun = undefined;
        }
        projection = {
          ...projection,
          ciRuns: [...ciRuns, payload.run],
          winningRun,
        };
        break;
      }
      case 'verification.recorded':
        projection = {
          ...projection,
          verifications: [...projection.verifications, payload.verification],
        };
        break;
      case 'artifact.recorded':
        projection = {
          ...projection,
          artifacts: [...projection.artifacts, payload.artifact],
        };
        break;
      case 'agent.attempt.recorded':
        projection = {
          ...projection,
          agentAttempts: [...projection.agentAttempts, payload.attempt],
        };
        break;
      case 'change.superseded':
        projection = {
          ...projection,
          state: 'superseded',
          summary: payload.reason,
          blocker: undefined,
          supersededBy: payload.replacementChangeId,
        };
        break;
      default: {
        const exhaustive: never = payload;
        throw new Error(`Unsupported lifecycle event: ${exhaustive}`);
      }
    }
    if (payload.kind !== 'change.created' || index === 0) {
      projection.updatedAt = envelope.occurredAt;
    }
  }

  return lifecycleProjectionSchema.parse(projection);
}
