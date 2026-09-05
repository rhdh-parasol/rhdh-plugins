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
import type { LifecycleEvent } from '@red-hat-developer-hub/backstage-plugin-lifecycle-common';
import { reduceLifecycleEvents } from './projection';

const changeId = '18163e4e-b0a5-431b-80f1-4913362d9926';

function event(
  eventId: string,
  occurredAt: string,
  payload: LifecycleEvent['payload'],
): LifecycleEvent {
  return {
    eventId,
    changeId,
    schemaVersion: 2,
    occurredAt,
    ingestedAt: occurredAt,
    actorRef: 'user:default/tester',
    producer: 'test',
    payload,
  };
}

describe('reduceLifecycleEvents', () => {
  it('reconstructs phase, evidence, winning run, and artifact provenance', () => {
    const projection = reduceLifecycleEvents([
      event('created', '2026-09-01T10:00:00.000Z', {
        kind: 'change.created',
        title: 'Upgrade plugin',
        initialReferences: [],
      }),
      event('pr', '2026-09-01T10:01:00.000Z', {
        kind: 'reference.linked',
        reference: {
          type: 'pull_request',
          title: 'Upgrade PR',
          url: 'https://github.com/example/repo/pull/1',
        },
      }),
      event('build', '2026-09-01T10:02:00.000Z', {
        kind: 'ci.run.recorded',
        run: {
          provider: 'github-actions',
          workflow: 'CI',
          runId: '42',
          attempt: 2,
          status: 'completed',
          conclusion: 'success',
          winning: true,
          fixture: false,
        },
      }),
      event('published', '2026-09-01T10:03:00.000Z', {
        kind: 'phase.updated',
        phase: 'publication',
        state: 'succeeded',
        summary: 'Published',
      }),
      event('oci', '2026-09-01T10:04:00.000Z', {
        kind: 'artifact.recorded',
        artifact: {
          artifactType: 'oci',
          reference: 'oci://ghcr.io/example/plugin:1.0.0',
        },
      }),
    ]);

    expect(projection).toMatchObject({
      phase: 'publication',
      state: 'succeeded',
      winningRun: { runId: '42', attempt: 2 },
    });
    expect(projection.references).toHaveLength(1);
    expect(projection.artifacts).toHaveLength(1);
  });

  it('allows rework to return from verification to implementation', () => {
    const projection = reduceLifecycleEvents([
      event('created', '2026-09-01T10:00:00.000Z', {
        kind: 'change.created',
        title: 'Upgrade plugin',
        initialReferences: [],
      }),
      event('blocked', '2026-09-01T10:01:00.000Z', {
        kind: 'phase.updated',
        phase: 'verification',
        state: 'blocked',
        summary: 'Verification failed',
        blocker: 'Missing Legacy export',
      }),
      event('rework', '2026-09-01T10:02:00.000Z', {
        kind: 'phase.updated',
        phase: 'implementation',
        state: 'running',
        summary: 'Applying correction',
      }),
    ]);
    expect(projection).toMatchObject({
      phase: 'implementation',
      state: 'running',
      blocker: undefined,
    });
  });

  it('does not let a late system creation record replace external evidence', () => {
    const projection = reduceLifecycleEvents([
      event('failed', '2026-09-01T10:00:00.000Z', {
        kind: 'phase.updated',
        phase: 'build',
        state: 'failed',
        summary: 'Workspace export failed',
      }),
      event('created', '2026-09-03T10:00:00.000Z', {
        kind: 'change.created',
        title: 'Imported workflow change',
        summary: 'Generic GitHub Actions evidence',
        initialReferences: [],
      }),
    ]);

    expect(projection).toMatchObject({
      phase: 'build',
      state: 'failed',
      summary: 'Workspace export failed',
      updatedAt: '2026-09-01T10:00:00.000Z',
    });
  });

  it('retains all CI attempts while selecting only the winning run', () => {
    const projection = reduceLifecycleEvents([
      event('created', '2026-09-01T10:00:00.000Z', {
        kind: 'change.created',
        title: 'Upgrade plugin',
        initialReferences: [],
      }),
      event('attempt-1', '2026-09-01T10:01:00.000Z', {
        kind: 'ci.run.recorded',
        run: {
          provider: 'github-actions',
          workflow: 'Publish',
          runId: '42',
          attempt: 1,
          status: 'completed',
          conclusion: 'failure',
          winning: false,
          fixture: false,
        },
      }),
      event('attempt-2', '2026-09-01T10:02:00.000Z', {
        kind: 'ci.run.recorded',
        run: {
          provider: 'github-actions',
          workflow: 'Publish',
          runId: '42',
          attempt: 2,
          status: 'completed',
          conclusion: 'success',
          winning: true,
          fixture: false,
        },
      }),
    ]);

    expect(projection.ciRuns).toHaveLength(2);
    expect(projection.winningRun).toMatchObject({ runId: '42', attempt: 2 });
  });
});
