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
import path from 'path';
import { ConflictError, NotFoundError } from '@backstage/errors';
import knex, { type Knex } from 'knex';
import { LifecycleStore } from './LifecycleStore';

describe('LifecycleStore', () => {
  let db: Knex;
  let store: LifecycleStore;

  beforeEach(async () => {
    db = knex({
      client: 'better-sqlite3',
      connection: ':memory:',
      useNullAsDefault: true,
    });
    await db.migrate.latest({
      directory: path.resolve(__dirname, '../../migrations'),
    });
    store = new LifecycleStore(db);
  });

  afterEach(async () => {
    await db.destroy();
  });

  it('creates changes idempotently and rejects conflicting request IDs', async () => {
    const input = {
      requestId: 'request-1',
      subjectEntityRef: 'plugin:rhdh/global-header',
      title: 'Upgrade Global Header',
      initialReferences: [],
    };
    const first = await store.createChange(input, 'user:default/tester');
    const retry = await store.createChange(input, 'user:default/tester');
    expect(retry.summary.changeId).toBe(first.summary.changeId);

    await expect(
      store.createChange(
        { ...input, title: 'Different request' },
        'user:default/tester',
      ),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it('preserves the external occurrence time for system-imported changes', async () => {
    const occurredAt = '2026-09-01T08:00:00.000Z';
    const created = await store.createChange(
      {
        requestId: 'external-change-time',
        subjectEntityRef: 'component:default/overlay-example',
        title: 'Imported workflow change',
        initialReferences: [],
      },
      'system:plugin-lifecycle',
      { origin: 'github-actions', occurredAt },
    );

    const context = await store.getContext(
      'component:default/overlay-example',
      { changeId: created.summary.changeId, eventLimit: 100 },
    );
    expect(context.events[0]).toMatchObject({
      occurredAt,
      payload: { kind: 'change.created' },
    });
    expect(context.projection?.updatedAt).toBe(occurredAt);
  });

  it('reprojects late events and reconstructs historical state', async () => {
    const created = await store.createChange(
      {
        requestId: 'request-history',
        subjectEntityRef: 'plugin:rhdh/global-header',
        title: 'Upgrade Global Header',
        initialReferences: [],
      },
      'user:default/tester',
    );
    const changeId = created.summary.changeId;
    await store.appendEvent(
      {
        eventId: 'published',
        changeId,
        occurredAt: '2026-09-01T12:00:00.000Z',
        producer: 'test',
        event: {
          kind: 'phase.updated',
          phase: 'publication',
          state: 'succeeded',
          summary: 'Published',
        },
      },
      'user:default/tester',
    );
    await store.appendEvent(
      {
        eventId: 'blocked-late',
        changeId,
        occurredAt: '2026-09-01T11:00:00.000Z',
        producer: 'test',
        event: {
          kind: 'phase.updated',
          phase: 'verification',
          state: 'blocked',
          summary: 'Verification blocked',
        },
      },
      'user:default/tester',
    );

    const current = await store.getContext('plugin:rhdh/global-header', {
      eventLimit: 100,
    });
    expect(current.projection).toMatchObject({
      phase: 'publication',
      state: 'succeeded',
    });
    expect(
      current.events.every(event => /^\d+$/.test(event.eventCursor ?? '')),
    ).toBe(true);

    const historical = await store.getContext('plugin:rhdh/global-header', {
      changeId,
      asOf: '2026-09-01T11:30:00.000Z',
      eventLimit: 100,
    });
    expect(historical.projection).toMatchObject({
      phase: 'verification',
      state: 'blocked',
    });
  });

  it('returns the last successful build and artifacts across newer failed changes', async () => {
    const successful = await store.createChange(
      {
        requestId: 'successful-publication',
        subjectEntityRef: 'component:default/overlay-example',
        title: 'Example 1.0.0 publication',
        initialReferences: [],
      },
      'system:plugin-lifecycle',
    );
    await store.appendEvent(
      {
        eventId: 'successful-build',
        changeId: successful.summary.changeId,
        occurredAt: '2026-09-01T10:00:00.000Z',
        producer: 'github-actions-collector',
        event: {
          kind: 'ci.run.recorded',
          run: {
            provider: 'github-actions',
            workflow: 'Publish',
            runId: '42',
            runNumber: 42,
            runAttempt: 1,
            status: 'completed',
            conclusion: 'success',
            updatedAt: '2026-09-01T10:00:00.000Z',
            winning: true,
            fixture: false,
          },
        },
      },
      'system:plugin-lifecycle',
    );
    await store.appendEvent(
      {
        eventId: 'successful-image',
        changeId: successful.summary.changeId,
        occurredAt: '2026-09-01T10:01:00.000Z',
        producer: 'github-actions-collector',
        event: {
          kind: 'artifact.recorded',
          artifact: {
            artifactType: 'oci',
            reference: 'oci://example/plugin:1.0.0',
            digest:
              'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
          },
        },
      },
      'system:plugin-lifecycle',
    );

    const failed = await store.createChange(
      {
        requestId: 'failed-publication',
        subjectEntityRef: 'component:default/overlay-example',
        title: 'Example 1.1.0 publication',
        initialReferences: [],
      },
      'system:plugin-lifecycle',
    );
    await store.appendEvent(
      {
        eventId: 'failed-build',
        changeId: failed.summary.changeId,
        occurredAt: '2026-09-02T10:00:00.000Z',
        producer: 'github-actions-collector',
        event: {
          kind: 'ci.run.recorded',
          run: {
            provider: 'github-actions',
            workflow: 'Publish',
            runId: '43',
            runNumber: 43,
            runAttempt: 1,
            status: 'completed',
            conclusion: 'failure',
            updatedAt: '2026-09-02T10:00:00.000Z',
            winning: false,
            fixture: false,
          },
        },
      },
      'system:plugin-lifecycle',
    );

    const context = await store.getContext(
      'component:default/overlay-example',
      { eventLimit: 100 },
    );
    expect(context.selectedChange?.changeId).toBe(failed.summary.changeId);
    expect(context.lastSuccessfulPublication).toMatchObject({
      change: { changeId: successful.summary.changeId },
      run: { runId: '42', conclusion: 'success' },
      artifacts: [
        {
          artifactType: 'oci',
          digest:
            'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
        },
      ],
    });
  });

  it('does not promote fixture publications into the current summary', async () => {
    const fixture = await store.createChange(
      {
        requestId: 'fixture-publication',
        subjectEntityRef: 'component:default/overlay-fixture',
        title: 'Fixture publication',
        initialReferences: [],
      },
      'system:fixture',
      { origin: 'fixture' },
    );
    await store.appendEvent(
      {
        eventId: 'fixture-build',
        changeId: fixture.summary.changeId,
        occurredAt: '2026-09-03T10:00:00.000Z',
        producer: 'fixture',
        event: {
          kind: 'ci.run.recorded',
          run: {
            provider: 'fixture',
            workflow: 'Publish',
            runId: 'fixture-run',
            runNumber: 1,
            runAttempt: 1,
            status: 'completed',
            conclusion: 'success',
            updatedAt: '2026-09-03T10:00:00.000Z',
            winning: true,
            fixture: true,
          },
        },
      },
      'system:fixture',
    );
    await store.appendEvent(
      {
        eventId: 'fixture-image',
        changeId: fixture.summary.changeId,
        occurredAt: '2026-09-03T10:01:00.000Z',
        producer: 'fixture',
        event: {
          kind: 'artifact.recorded',
          artifact: {
            artifactType: 'oci',
            reference: 'oci://example/plugin:fixture',
            digest:
              'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
          },
        },
      },
      'system:fixture',
    );

    const context = await store.getContext(
      'component:default/overlay-fixture',
      { eventLimit: 100 },
    );
    expect(context.lastSuccessfulPublication).toBeUndefined();
  });

  it('keeps event ingestion idempotent', async () => {
    const created = await store.createChange(
      {
        requestId: 'request-event',
        subjectEntityRef: 'plugin:default/example',
        title: 'Example plugin change',
        initialReferences: [],
      },
      'user:default/tester',
    );
    const input = {
      eventId: 'event-1',
      changeId: created.summary.changeId,
      occurredAt: '2026-09-01T11:00:00.000Z',
      producer: 'test',
      event: {
        kind: 'phase.updated' as const,
        phase: 'build' as const,
        state: 'running' as const,
        summary: 'Building',
      },
    };
    const first = await store.appendEvent(input, 'user:default/tester');
    const retry = await store.appendEvent(
      { ...input, occurredAt: '2026-09-01T11:00:00Z' },
      'user:default/retry-operator',
    );
    expect(retry.event.eventId).toBe(first.event.eventId);
    expect(retry.event.actorRef).toBe('user:default/tester');

    await expect(
      store.appendEvent(
        {
          ...input,
          event: { ...input.event, summary: 'Different' },
        },
        'user:default/tester',
      ),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it('rejects an event ID reused for another change', async () => {
    const first = await store.createChange(
      {
        requestId: 'event-change-one',
        subjectEntityRef: 'plugin:default/example',
        title: 'First change',
        initialReferences: [],
      },
      'user:default/tester',
    );
    const second = await store.createChange(
      {
        requestId: 'event-change-two',
        subjectEntityRef: 'plugin:default/example',
        title: 'Second change',
        initialReferences: [],
      },
      'user:default/tester',
    );
    const event = {
      eventId: 'globally-unique-event',
      changeId: first.summary.changeId,
      occurredAt: '2026-09-01T11:00:00.000Z',
      producer: 'test',
      event: {
        kind: 'phase.updated' as const,
        phase: 'build' as const,
        state: 'running' as const,
        summary: 'Building',
      },
    };
    await store.appendEvent(event, 'user:default/tester');

    await expect(
      store.appendEvent(
        { ...event, changeId: second.summary.changeId },
        'user:default/tester',
      ),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it('returns no invented projection before the change existed', async () => {
    const created = await store.createChange(
      {
        requestId: 'before-creation',
        subjectEntityRef: 'plugin:default/example',
        title: 'Future change',
        initialReferences: [],
      },
      'user:default/tester',
    );
    const context = await store.getContext('plugin:default/example', {
      changeId: created.summary.changeId,
      asOf: '1970-01-01T00:00:00.000Z',
      eventLimit: 100,
    });

    expect(context.events).toEqual([]);
    expect(context.projection).toBeUndefined();
  });

  it('orders equal-time events by their database sequence and applies limits last', async () => {
    const created = await store.createChange(
      {
        requestId: 'equal-event-times',
        subjectEntityRef: 'plugin:default/example',
        title: 'Deterministic events',
        initialReferences: [],
      },
      'user:default/tester',
    );
    const occurredAt = '2026-09-01T11:00:00.000Z';
    for (const [eventId, state] of [
      ['same-time-one', 'blocked'],
      ['same-time-two', 'running'],
    ] as const) {
      await store.appendEvent(
        {
          eventId,
          changeId: created.summary.changeId,
          occurredAt,
          producer: 'test',
          event: {
            kind: 'phase.updated',
            phase: 'verification',
            state,
            summary: state,
          },
        },
        'user:default/tester',
      );
    }

    const context = await store.getContext('plugin:default/example', {
      eventLimit: 1,
    });
    expect(context.projection?.state).toBe('running');
    expect(context.events.map(event => event.eventId)).toEqual([
      expect.stringMatching(/^change-created:/),
    ]);
  });

  it('isolates changes for different plugins', async () => {
    await store.createChange(
      {
        requestId: 'one',
        subjectEntityRef: 'plugin:default/one',
        title: 'One',
        initialReferences: [],
      },
      'user:default/tester',
    );
    await store.createChange(
      {
        requestId: 'two',
        subjectEntityRef: 'plugin:default/two',
        title: 'Two',
        initialReferences: [],
      },
      'user:default/tester',
    );
    expect(
      (await store.getContext('plugin:default/one', { eventLimit: 100 }))
        .changes,
    ).toHaveLength(1);
  });

  it('rejects an explicit change selection when the plugin has no changes', async () => {
    await expect(
      store.getContext('plugin:default/example', {
        changeId: '18163e4e-b0a5-431b-80f1-4913362d9926',
        eventLimit: 100,
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('selects the most recently updated non-terminal change for a plugin', async () => {
    const first = await store.createChange(
      {
        requestId: 'selection-first',
        subjectEntityRef: 'plugin:default/example',
        title: 'Published change',
        initialReferences: [],
      },
      'user:default/tester',
    );
    await store.appendEvent(
      {
        eventId: 'selection-published',
        changeId: first.summary.changeId,
        occurredAt: '2026-09-01T12:00:00.000Z',
        producer: 'test',
        event: {
          kind: 'phase.updated',
          phase: 'publication',
          state: 'succeeded',
          summary: 'Published',
        },
      },
      'user:default/tester',
    );
    const second = await store.createChange(
      {
        requestId: 'selection-second',
        subjectEntityRef: 'plugin:default/example',
        title: 'Active change',
        initialReferences: [],
      },
      'user:default/tester',
      { scope: 'pull_request', externalStatus: 'open' },
    );

    const context = await store.getContext('plugin:default/example', {
      eventLimit: 100,
    });
    expect(context.changes).toHaveLength(2);
    expect(context.selectedChange?.changeId).toBe(second.summary.changeId);
  });
});
