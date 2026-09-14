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
import { randomUUID } from 'crypto';
import type { DatabaseService } from '@backstage/backend-plugin-api';
import { ConflictError, NotFoundError } from '@backstage/errors';
import type { Knex } from 'knex';
import {
  API_SCHEMA_VERSION,
  type CreateChangeInput,
  type LifecycleEvent,
  type LifecycleProjection,
  type RecordEventInput,
  createChangeInputSchema,
  lifecycleEventSchema,
  lifecycleProjectionSchema,
  recordEventInputSchema,
} from '@red-hat-developer-hub/backstage-plugin-lifecycle-common';
import { migrate } from './migration';
import { reduceLifecycleEvents } from './projection';
import type {
  ChangeAssociation,
  CreateChangeOptions,
  LifecycleSubject,
  LifecycleSubjectBinding,
  LifecycleSyncState,
  StoredChange,
  StoredContext,
} from './types';
import type { ChangeRow, DiagnosticRow, EventRow } from './rows';
import {
  canonicalJson,
  diagnosticId,
  eventIdentity,
  parseJson,
  storedEvent,
} from './serialization';
import {
  MAX_CONTEXT_PR_CHANGES,
  changeSummary,
  hasSuccessfulMainlineBuild,
  lastSuccessfulPublication,
} from './changeReadModel';
import { SubjectRepository } from './subjectRepository';

function isSystemIdentityMatch(
  row: ChangeRow | undefined,
  origin: string,
  externalChangeKey: string | undefined,
): boolean {
  return Boolean(
    row &&
      origin === 'github-actions' &&
      externalChangeKey &&
      row.origin === 'github-actions' &&
      row.external_change_key === externalChangeKey,
  );
}

/** @public */
export class LifecycleStore {
  static async create(database: DatabaseService): Promise<LifecycleStore> {
    await migrate(database);
    return new LifecycleStore(await database.getClient());
  }

  private readonly subjects: SubjectRepository;

  constructor(private readonly db: Knex) {
    this.subjects = new SubjectRepository(db);
  }

  async createChange(
    rawInput: CreateChangeInput,
    actorRef: string,
    options: CreateChangeOptions = {},
  ): Promise<StoredChange> {
    const input = createChangeInputSchema.parse(rawInput);
    const requestPayload = canonicalJson(input);
    const origin = options.origin ?? 'action';
    const associations = this.normalizeAssociations(
      input.subjectEntityRef,
      options.associations ?? [],
    );

    return this.db.transaction(async trx => {
      let existing = await trx<ChangeRow>('lifecycle_changes')
        .where({ request_id: input.requestId })
        .first();
      if (!existing && options.externalChangeKey) {
        existing = await trx<ChangeRow>('lifecycle_changes')
          .where({ external_change_key: options.externalChangeKey })
          .first();
      }
      if (existing) {
        const isSystemIdentity = isSystemIdentityMatch(
          existing,
          origin,
          options.externalChangeKey,
        );
        if (
          !isSystemIdentity &&
          existing.request_payload_json !== requestPayload
        ) {
          throw new ConflictError(
            `Lifecycle identifier was already used with different input`,
          );
        }
        if (isSystemIdentity) {
          // GitHub display fields are mutable (for example, a PR title can be
          // edited). Stable external identity is the idempotency key for
          // imported changes; keep the projection metadata current without
          // creating a second change or weakening user requestId semantics.
          const displayChanged =
            existing.title !== input.title ||
            (existing.summary ?? null) !== (input.summary ?? null);
          if (displayChanged) {
            const displayUpdatedAt = new Date().toISOString();
            await trx<ChangeRow>('lifecycle_changes')
              .where({ id: existing.id })
              .update({
                title: input.title,
                summary: input.summary ?? null,
                updated_at: displayUpdatedAt,
              });
            existing = {
              ...existing,
              title: input.title,
              summary: input.summary ?? null,
              updated_at: displayUpdatedAt,
            };
          }
        }
        await this.insertAssociations(trx, existing.id, associations);
        return {
          summary: changeSummary(existing),
          projection: lifecycleProjectionSchema.parse(
            parseJson(existing.projection_json),
          ),
        };
      }

      const changeId = randomUUID();
      const now = new Date().toISOString();
      const occurredAt = options.occurredAt ?? now;
      const createdEvent = lifecycleEventSchema.parse({
        eventId: `change-created:${changeId}`,
        changeId,
        schemaVersion: API_SCHEMA_VERSION,
        occurredAt,
        ingestedAt: now,
        actorRef,
        producer: 'plugin-lifecycle',
        payload: {
          kind: 'change.created',
          title: input.title,
          summary: input.summary,
          target: input.target,
          initialReferences: input.initialReferences,
        },
      });
      const projection = reduceLifecycleEvents([createdEvent]);

      const inserted = await trx<ChangeRow>('lifecycle_changes')
        .insert({
          id: changeId,
          request_id: input.requestId,
          request_payload_json: requestPayload,
          subject_entity_ref: input.subjectEntityRef,
          origin,
          external_change_key: options.externalChangeKey ?? null,
          scope: options.scope ?? 'manual',
          external_status: options.externalStatus ?? 'open',
          title: input.title,
          summary: input.summary ?? null,
          current_phase: projection.phase,
          current_state: projection.state,
          projection_json: canonicalJson(projection),
          created_by: actorRef,
          created_at: now,
          updated_at: now,
          projected_at: now,
          last_occurred_at: occurredAt,
        })
        .onConflict('request_id')
        .ignore()
        .returning('id');

      if (inserted.length === 0) {
        let concurrentlyCreated = await trx<ChangeRow>('lifecycle_changes')
          .where({ request_id: input.requestId })
          .first();
        if (!concurrentlyCreated) {
          throw new Error('Concurrent lifecycle change was not persisted');
        }
        const isSystemIdentity = isSystemIdentityMatch(
          concurrentlyCreated,
          origin,
          options.externalChangeKey,
        );
        if (
          !isSystemIdentity &&
          concurrentlyCreated.request_payload_json !== requestPayload
        ) {
          throw new ConflictError(
            `requestId "${input.requestId}" was already used with different input`,
          );
        }
        if (isSystemIdentity) {
          const displayUpdatedAt = new Date().toISOString();
          await trx<ChangeRow>('lifecycle_changes')
            .where({ id: concurrentlyCreated.id })
            .update({
              title: input.title,
              summary: input.summary ?? null,
              updated_at: displayUpdatedAt,
            });
          concurrentlyCreated = {
            ...concurrentlyCreated,
            title: input.title,
            summary: input.summary ?? null,
            updated_at: displayUpdatedAt,
          };
        }
        await this.insertAssociations(
          trx,
          concurrentlyCreated.id,
          associations,
        );
        return {
          summary: changeSummary(concurrentlyCreated),
          projection: lifecycleProjectionSchema.parse(
            parseJson(concurrentlyCreated.projection_json),
          ),
        };
      }

      await this.insertEvent(trx, createdEvent);
      await this.insertAssociations(trx, changeId, associations);

      const created = await trx<ChangeRow>('lifecycle_changes')
        .where({ id: changeId })
        .first();
      if (!created) throw new Error('Lifecycle change was not persisted');
      return { summary: changeSummary(created), projection };
    });
  }

  async appendEvent(
    rawInput: RecordEventInput,
    actorRef: string,
  ): Promise<{ event: LifecycleEvent; projection: LifecycleProjection }> {
    const input = recordEventInputSchema.parse(rawInput);
    const ingestedAt = new Date().toISOString();
    const event = lifecycleEventSchema.parse({
      eventId: input.eventId,
      changeId: input.changeId,
      schemaVersion: API_SCHEMA_VERSION,
      occurredAt: input.occurredAt,
      ingestedAt,
      actorRef,
      producer: input.producer,
      payload: input.event,
    });

    return this.db.transaction(async trx => {
      const existingEvent = await trx<EventRow>('lifecycle_events')
        .where({ event_id: input.eventId })
        .first();
      if (existingEvent) {
        const stored = storedEvent(existingEvent);
        if (eventIdentity(stored) !== eventIdentity(event)) {
          throw new ConflictError(
            `eventId "${input.eventId}" was already used with different input`,
          );
        }
        const storedChange = await this.requireChange(
          trx,
          stored.changeId,
          true,
        );
        return {
          event: stored,
          projection: lifecycleProjectionSchema.parse(
            parseJson(storedChange.projection_json),
          ),
        };
      }

      await this.requireChange(trx, input.changeId, true);
      const inserted = await this.insertEvent(trx, event);
      if (!inserted) {
        const concurrentlyInserted = await trx<EventRow>('lifecycle_events')
          .where({ event_id: input.eventId })
          .first();
        if (!concurrentlyInserted) {
          throw new Error('Concurrent lifecycle event was not persisted');
        }
        const stored = storedEvent(concurrentlyInserted);
        if (eventIdentity(stored) !== eventIdentity(event)) {
          throw new ConflictError(
            `eventId "${input.eventId}" was already used with different input`,
          );
        }
        const storedChange = await this.requireChange(trx, stored.changeId);
        return {
          event: stored,
          projection: lifecycleProjectionSchema.parse(
            parseJson(storedChange.projection_json),
          ),
        };
      }
      const projection = await this.reproject(trx, input.changeId);
      return { event, projection };
    });
  }

  async addAssociations(
    changeId: string,
    associations: ChangeAssociation[],
  ): Promise<void> {
    await this.db.transaction(async trx => {
      await this.requireChange(trx, changeId, true);
      await this.insertAssociations(trx, changeId, associations);
    });
  }

  async getAssociations(changeId: string): Promise<ChangeAssociation[]> {
    const rows = await this.db('lifecycle_change_entities')
      .where({ change_id: changeId })
      .select(['entity_ref', 'role', 'relation_source']);
    return rows.map(row => ({
      entityRef: row.entity_ref,
      role: row.role,
      relationSource: row.relation_source,
    }));
  }

  async upsertSubject(input: {
    id?: string;
    overlayEntityRef: string;
    workspace: string;
    overlayRepository: string;
    sourceRepository?: string;
    sourceRevision?: string;
    mappingStatus: LifecycleSubject['mappingStatus'];
    mappingHash: string;
    bindings: Array<
      Omit<
        LifecycleSubjectBinding,
        'subjectId' | 'firstObservedAt' | 'lastObservedAt'
      >
    >;
  }): Promise<LifecycleSubject> {
    return this.subjects.upsert(input);
  }

  async getSubjectByEntity(
    entityRef: string,
  ): Promise<LifecycleSubject | undefined> {
    return this.subjects.getByEntity(entityRef);
  }

  async getSubjectsByEntity(entityRef: string): Promise<LifecycleSubject[]> {
    return this.subjects.listByEntity(entityRef);
  }

  async getSubjectBindings(
    subjectId: string,
  ): Promise<LifecycleSubjectBinding[]> {
    return this.subjects.getBindings(subjectId);
  }

  async getSyncState(subjectId: string): Promise<LifecycleSyncState> {
    return this.subjects.getSyncState(subjectId);
  }

  async getBootstrapStatus(
    bootstrapKey: string,
  ): Promise<'not_started' | 'running' | 'completed' | 'failed'> {
    const row = await this.db('lifecycle_bootstrap_runs')
      .where({ bootstrap_key: bootstrapKey })
      .first();
    if (!row) return 'not_started';
    return row.status === 'completed' || row.status === 'failed'
      ? row.status
      : 'running';
  }

  async setSyncState(
    subjectId: string,
    state: LifecycleSyncState,
  ): Promise<void> {
    return this.subjects.setSyncState(subjectId, state);
  }

  async listSubjects(): Promise<LifecycleSubject[]> {
    return this.subjects.list();
  }

  async claimBootstrap(
    bootstrapKey: string,
    repository: string,
    workflow: string,
    manifestSchemaVersion = '1',
  ): Promise<boolean> {
    const now = new Date().toISOString();
    const existing = await this.db('lifecycle_bootstrap_runs')
      .where({ bootstrap_key: bootstrapKey })
      .first();
    if (existing?.status === 'completed') return false;
    if (existing) {
      // A second backend must not start a duplicate bootstrap while the
      // current worker is alive. A stale lease is recoverable after a crash.
      if (
        existing.status === 'running' &&
        existing.started_at &&
        Date.now() - new Date(existing.started_at).getTime() < 10 * 60_000
      ) {
        return false;
      }
      await this.db('lifecycle_bootstrap_runs')
        .where({ bootstrap_key: bootstrapKey })
        .update({
          status: 'running',
          started_at: now,
          completed_at: null,
          error_summary: null,
        });
      return true;
    }
    const inserted = await this.db('lifecycle_bootstrap_runs')
      .insert({
        bootstrap_key: bootstrapKey,
        repository,
        workflow,
        manifest_schema_version: manifestSchemaVersion,
        status: 'running',
        started_at: now,
        subject_count: 0,
        evidence_count: 0,
      })
      .onConflict('bootstrap_key')
      .ignore()
      .returning('bootstrap_key');
    return inserted.length > 0;
  }

  async completeBootstrap(
    bootstrapKey: string,
    status: 'completed' | 'failed',
    subjectCount: number,
    evidenceCount: number,
    errorSummary?: string,
  ): Promise<void> {
    await this.db('lifecycle_bootstrap_runs')
      .where({ bootstrap_key: bootstrapKey })
      .update({
        status,
        completed_at: new Date().toISOString(),
        subject_count: subjectCount,
        evidence_count: evidenceCount,
        error_summary: errorSummary ?? null,
      });
  }

  async getContext(
    entityRef: string,
    options: {
      changeId?: string;
      asOf?: string;
      asOfEventId?: string;
      eventLimit: number;
    },
  ): Promise<StoredContext> {
    const associationRows = await this.db('lifecycle_change_entities')
      .where({ entity_ref: entityRef })
      .select('change_id');
    const changeIds = [
      ...new Set(associationRows.map(row => String(row.change_id))),
    ];
    const rows = changeIds.length
      ? await this.db<ChangeRow>('lifecycle_changes')
          .whereIn('id', changeIds)
          .orderBy([
            { column: 'updated_at', order: 'desc' },
            { column: 'created_at', order: 'desc' },
            { column: 'id', order: 'desc' },
          ])
      : [];
    if (rows.length === 0) {
      if (options.changeId) {
        throw new NotFoundError(
          `Lifecycle change "${options.changeId}" was not found for "${entityRef}"`,
        );
      }
      return { changes: [], events: [] };
    }

    const selected = options.changeId
      ? rows.find(row => row.id === options.changeId)
      : rows.find(
          row =>
            row.scope === 'pull_request' &&
            row.external_status === 'open' &&
            row.current_state !== 'superseded',
        ) ??
        rows.find(
          row =>
            row.external_status === 'published' ||
            hasSuccessfulMainlineBuild(row),
        ) ??
        rows[0];
    if (!selected) {
      throw new NotFoundError(
        `Lifecycle change "${options.changeId}" was not found for "${entityRef}"`,
      );
    }

    // Keep the durable history complete, but keep the default context small
    // enough for a human selector and an agent response. Mainline observations
    // are summarized separately in delivery; expose only the newest branch
    // record here (plus an explicitly selected historical record).
    const visibleRows = rows.filter(row => row.scope !== 'branch');
    const boundedRows = [
      ...visibleRows.slice(0, MAX_CONTEXT_PR_CHANGES),
      ...rows.filter(row => row.scope === 'branch').slice(0, 1),
    ];
    if (!boundedRows.some(row => row.id === selected.id))
      boundedRows.push(selected);
    const changes = boundedRows.map(changeSummary);

    const allEvents = await this.readEvents(
      this.db,
      selected.id,
      options.asOf,
      options.asOfEventId,
    );
    let projection: LifecycleProjection | undefined;
    if (options.asOf || options.asOfEventId) {
      projection =
        allEvents.length > 0 ? reduceLifecycleEvents(allEvents) : undefined;
    } else {
      projection = lifecycleProjectionSchema.parse(
        parseJson(selected.projection_json),
      );
    }
    const events = allEvents.slice(-options.eventLimit);
    return {
      changes,
      selectedChange: changeSummary(selected),
      projection,
      lastSuccessfulPublication: options.asOf
        ? undefined
        : lastSuccessfulPublication(rows),
      events,
      asOfEventId: options.asOfEventId,
    };
  }

  /** Returns the current projections for every change associated with an entity. */
  async getChangeDetails(entityRef: string): Promise<StoredChange[]> {
    const associationRows = await this.db('lifecycle_change_entities')
      .where({ entity_ref: entityRef })
      .select('change_id');
    const changeIds = [
      ...new Set(associationRows.map(row => String(row.change_id))),
    ];
    if (changeIds.length === 0) return [];
    const rows = await this.db<ChangeRow>('lifecycle_changes')
      .whereIn('id', changeIds)
      .orderBy([
        { column: 'updated_at', order: 'desc' },
        { column: 'created_at', order: 'desc' },
        { column: 'id', order: 'desc' },
      ]);
    return rows.map(row => ({
      summary: changeSummary(row),
      projection: lifecycleProjectionSchema.parse(
        parseJson(row.projection_json),
      ),
    }));
  }

  /**
   * Updates the external lifecycle status without changing the immutable
   * event history. GitHub PR state is mutable outside RHDH, so the collector
   * uses this field to remove closed PRs from the active-candidate view while
   * retaining their complete history for inspection.
   */
  async updateExternalStatus(
    changeId: string,
    externalStatus: 'open' | 'merged' | 'closed' | 'published',
  ): Promise<void> {
    await this.db('lifecycle_changes').where({ id: changeId }).update({
      external_status: externalStatus,
      updated_at: new Date().toISOString(),
    });
  }

  async recordDiagnostic(input: {
    source: string;
    subjectEntityRef?: string;
    externalId?: string;
    reasonCode: string;
    summary: string;
    details: Record<string, unknown>;
  }): Promise<void> {
    const id = diagnosticId(input);
    const now = new Date().toISOString();
    const row = {
      diagnostic_id: id,
      source: input.source,
      subject_entity_ref: input.subjectEntityRef ?? null,
      external_id: input.externalId ?? null,
      reason_code: input.reasonCode,
      summary: input.summary,
      details_json: canonicalJson(input.details),
      first_seen_at: now,
      last_seen_at: now,
      resolved_at: null,
    };
    await this.db<DiagnosticRow>('lifecycle_ingestion_diagnostics')
      .insert(row)
      .onConflict('diagnostic_id')
      .merge({
        last_seen_at: now,
        summary: row.summary,
        details_json: row.details_json,
        resolved_at: null,
      });
  }

  async resolveDiagnostic(input: {
    source: string;
    externalId?: string;
    reasonCode: string;
  }): Promise<void> {
    const id = diagnosticId(input);
    await this.db<DiagnosticRow>('lifecycle_ingestion_diagnostics')
      .where({ diagnostic_id: id })
      .update({ resolved_at: new Date().toISOString() });
  }

  private normalizeAssociations(
    subjectEntityRef: string,
    associations: ChangeAssociation[],
  ): ChangeAssociation[] {
    const all = [
      {
        entityRef: subjectEntityRef,
        role: 'subject' as const,
        relationSource: 'subject' as const,
      },
      {
        entityRef: subjectEntityRef,
        role: 'overlay' as const,
        relationSource: 'subject' as const,
      },
      ...associations,
    ];
    const seen = new Set<string>();
    return all.filter(association => {
      const key = `${association.entityRef}:${association.role}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  private async insertAssociations(
    trx: Knex | Knex.Transaction,
    changeId: string,
    associations: ChangeAssociation[],
  ): Promise<void> {
    if (associations.length === 0) return;
    const now = new Date().toISOString();
    await trx('lifecycle_change_entities')
      .insert(
        associations.map(association => ({
          change_id: changeId,
          entity_ref: association.entityRef,
          role: association.role,
          relation_source: association.relationSource,
          created_at: now,
        })),
      )
      .onConflict(['change_id', 'entity_ref', 'role'])
      .ignore();
  }

  private async insertEvent(
    trx: Knex | Knex.Transaction,
    event: LifecycleEvent,
  ): Promise<boolean> {
    const inserted = await trx<EventRow>('lifecycle_events')
      .insert({
        event_id: event.eventId,
        change_id: event.changeId,
        schema_version: event.schemaVersion,
        kind: event.payload.kind,
        occurred_at: event.occurredAt,
        ingested_at: event.ingestedAt,
        actor_ref: event.actorRef,
        producer: event.producer,
        payload_json: canonicalJson(event.payload),
      })
      .onConflict('event_id')
      .ignore()
      .returning('event_id');
    return inserted.length > 0;
  }

  private async requireChange(
    trx: Knex | Knex.Transaction,
    changeId: string,
    forUpdate = false,
  ): Promise<ChangeRow> {
    let query = trx<ChangeRow>('lifecycle_changes').where({ id: changeId });
    if (forUpdate) query = query.forUpdate();
    const row = await query.first();
    if (!row)
      throw new NotFoundError(`Lifecycle change "${changeId}" was not found`);
    return row;
  }

  private async readEvents(
    trx: Knex,
    changeId: string,
    asOf?: string,
    asOfEventId?: string,
  ): Promise<LifecycleEvent[]> {
    let query = trx<EventRow>('lifecycle_events').where({
      change_id: changeId,
    });
    if (asOf) query = query.andWhere('occurred_at', '<=', asOf);
    if (asOfEventId) query = query.andWhere('id', '<=', asOfEventId);
    const rows = await query.orderBy([
      { column: 'occurred_at', order: 'asc' },
      { column: 'id', order: 'asc' },
    ]);
    return rows.map(storedEvent);
  }

  private async reproject(
    trx: Knex.Transaction,
    changeId: string,
  ): Promise<LifecycleProjection> {
    const change = await this.requireChange(trx, changeId);
    const events = await this.readEvents(trx, changeId);
    const projection = reduceLifecycleEvents(events);
    const now = new Date().toISOString();
    const updates: Record<string, unknown> = {
      current_phase: projection.phase,
      current_state: projection.state,
      projection_json: canonicalJson(projection),
      updated_at: now,
      projected_at: now,
      last_occurred_at: projection.updatedAt,
    };
    // A successful PR publication only proves that candidate images were
    // produced; the PR can still be open and must remain an active candidate
    // until GitHub reports its external state. Only a successful branch
    // publication can advance the stored external status automatically.
    if (
      change.scope === 'branch' &&
      projection.phase === 'publication' &&
      projection.state === 'succeeded'
    ) {
      updates.external_status = 'published';
    }
    await trx<ChangeRow>('lifecycle_changes')
      .where({ id: changeId })
      .update(updates);
    return projection;
  }
}
