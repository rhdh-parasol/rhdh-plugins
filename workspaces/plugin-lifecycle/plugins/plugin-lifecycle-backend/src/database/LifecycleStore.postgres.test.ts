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
import knex, { type Knex } from 'knex';
import { LifecycleStore } from './LifecycleStore';

const postgresUrl = process.env.LIFECYCLE_POSTGRES_URL;
const describePostgres = postgresUrl ? describe : describe.skip;

describePostgres('LifecycleStore PostgreSQL integration', () => {
  let db: Knex;
  let store: LifecycleStore;

  function connect(): Knex {
    return knex({
      client: 'pg',
      connection: postgresUrl,
    });
  }

  beforeAll(async () => {
    db = connect();
    await db.migrate.latest({
      directory: path.resolve(__dirname, '../../migrations'),
    });
  });

  beforeEach(async () => {
    await db('lifecycle_events').delete();
    await db('lifecycle_changes').delete();
    store = new LifecycleStore(db);
  });

  afterAll(async () => {
    await db.destroy();
  });

  it('persists, deterministically reprojects, and reconstructs history after reconnect', async () => {
    const input = {
      requestId: 'postgres-request',
      subjectEntityRef: 'plugin:default/postgres-example',
      title: 'PostgreSQL-backed lifecycle',
      initialReferences: [],
    };
    const created = await store.createChange(input, 'user:default/tester');
    const retry = await store.createChange(input, 'user:default/tester');
    expect(retry.summary.changeId).toBe(created.summary.changeId);

    const concurrentInput = {
      ...input,
      requestId: 'postgres-concurrent-request',
    };
    const concurrentCreates = await Promise.all(
      [1, 2, 3].map(() =>
        store.createChange(concurrentInput, 'user:default/tester'),
      ),
    );
    expect(
      new Set(concurrentCreates.map(result => result.summary.changeId)).size,
    ).toBe(1);

    await store.appendEvent(
      {
        eventId: 'postgres-published',
        changeId: created.summary.changeId,
        occurredAt: '2026-09-01T12:00:00.000Z',
        producer: 'postgres-test',
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
        eventId: 'postgres-blocked-late',
        changeId: created.summary.changeId,
        occurredAt: '2026-09-01T11:00:00.000Z',
        producer: 'postgres-test',
        event: {
          kind: 'phase.updated',
          phase: 'verification',
          state: 'blocked',
          summary: 'Verification blocked',
        },
      },
      'user:default/tester',
    );

    await Promise.all(
      [1, 2, 3].map(index =>
        store.appendEvent(
          {
            eventId: `postgres-concurrent-${index}`,
            changeId: created.summary.changeId,
            occurredAt: `2026-09-01T13:0${index}:00.000Z`,
            producer: 'postgres-concurrency-test',
            event: {
              kind: 'phase.updated',
              phase: index === 3 ? 'publication' : 'verification',
              state: index === 3 ? 'succeeded' : 'running',
              summary: `Concurrent event ${index}`,
            },
          },
          'user:default/tester',
        ),
      ),
    );

    await db.destroy();
    db = connect();
    store = new LifecycleStore(db);

    const current = await store.getContext(input.subjectEntityRef, {
      changeId: created.summary.changeId,
      eventLimit: 100,
    });
    expect(current.projection).toMatchObject({
      phase: 'publication',
      state: 'succeeded',
    });

    const historical = await store.getContext(input.subjectEntityRef, {
      changeId: created.summary.changeId,
      asOf: '2026-09-01T11:30:00.000Z',
      eventLimit: 100,
    });
    expect(historical.projection).toMatchObject({
      phase: 'verification',
      state: 'blocked',
    });
  });
});
