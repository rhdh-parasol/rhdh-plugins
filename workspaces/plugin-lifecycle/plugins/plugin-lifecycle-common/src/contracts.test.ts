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
  ciRunSchema,
  createChangeInputSchema,
  lifecycleEventPayloadSchema,
  recordEventInputSchema,
} from './contracts';

describe('Plugin Lifecycle contracts', () => {
  it('accepts a generic Catalog entity change', () => {
    expect(
      createChangeInputSchema.parse({
        requestId: 'demo-1',
        subjectEntityRef: 'component:default/overlay-global-header',
        title: 'Upgrade Global Header',
      }),
    ).toMatchObject({ initialReferences: [] });
  });

  it.each([
    'phase.updated',
    'reference.linked',
    'ci.run.recorded',
    'verification.recorded',
    'artifact.recorded',
    'agent.attempt.recorded',
    'change.superseded',
  ])('declares %s as a recordable event', kind => {
    const samples: Record<string, unknown> = {
      'phase.updated': {
        kind,
        phase: 'build',
        state: 'running',
        summary: 'Build started',
      },
      'reference.linked': {
        kind,
        reference: {
          type: 'pull_request',
          title: 'PR 1',
          url: 'https://github.com/example/repo/pull/1',
        },
      },
      'ci.run.recorded': {
        kind,
        run: {
          provider: 'github-actions',
          workflow: 'CI',
          runId: 'fixture-1',
          attempt: 1,
          status: 'completed',
          conclusion: 'success',
        },
      },
      'verification.recorded': {
        kind,
        verification: {
          method: 'playwright',
          state: 'succeeded',
          summary: 'Visible behavior verified',
        },
      },
      'artifact.recorded': {
        kind,
        artifact: {
          artifactType: 'oci',
          reference: 'oci://ghcr.io/example/plugin:1.0.0',
        },
      },
      'agent.attempt.recorded': {
        kind,
        attempt: {
          agent: 'sandbox-agent',
          state: 'succeeded',
          summary: 'Prepared the change',
        },
      },
      'change.superseded': { kind, reason: 'Replaced by another change' },
    };
    const parsed = lifecycleEventPayloadSchema.parse(samples[kind]);
    expect(
      lifecycleEventPayloadSchema.parse(JSON.parse(JSON.stringify(parsed))),
    ).toEqual(parsed);
  });

  it('rejects change.created through the public record action', () => {
    expect(() =>
      recordEventInputSchema.parse({
        eventId: 'event-1',
        changeId: '18163e4e-b0a5-431b-80f1-4913362d9926',
        occurredAt: '2026-09-01T00:00:00.000Z',
        producer: 'test',
        event: {
          kind: 'change.created',
          title: 'Not allowed',
        },
      }),
    ).toThrow();
  });

  it.each([
    {
      status: 'completed',
      winning: false,
      fixture: false,
    },
    {
      status: 'queued',
      conclusion: 'success',
      winning: false,
      fixture: false,
    },
    {
      status: 'completed',
      conclusion: 'failure',
      winning: true,
      fixture: false,
    },
  ])('rejects internally inconsistent CI facts', invalidRun => {
    expect(() =>
      ciRunSchema.parse({
        provider: 'github-actions',
        workflow: 'CI',
        runId: '42',
        attempt: 1,
        ...invalidRun,
      }),
    ).toThrow();
  });
});
