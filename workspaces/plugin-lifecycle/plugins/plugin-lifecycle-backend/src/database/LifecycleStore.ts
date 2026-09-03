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
import { createHash, randomUUID } from 'crypto';
import type { DatabaseService } from '@backstage/backend-plugin-api';
import { ConflictError, NotFoundError } from '@backstage/errors';
import type { Knex } from 'knex';
import {
  API_SCHEMA_VERSION,
  type CreateChangeInput,
  type LifecycleChangeSummary,
  type LifecycleEvent,
  type LifecycleProjection,
  type LifecycleSuccessfulPublication,
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

interface ChangeRow {
  id: string;
  request_id: string;
  request_payload_json: string;
  subject_entity_ref: string;
  origin: string;
  external_change_key: string | null;
  scope: string;
  external_status: string;
  last_occurred_at: string | Date | null;
  title: string;
  summary: string | null;
  current_phase: string;
  current_state: string;
  projection_json: string;
  created_by: string;
  created_at: string | Date;
  updated_at: string | Date;
  projected_at: string | Date;
}

interface EventRow {
  id: number | string;
  event_id: string;
  change_id: string;
  schema_version: number;
  kind: string;
  occurred_at: string | Date;
  ingested_at: string | Date;
  actor_ref: string;
  producer: string;
  payload_json: string;
}

interface DiagnosticRow {
  diagnostic_id: string;
  source: string;
  subject_entity_ref: string | null;
  external_id: string | null;
  reason_code: string;
  summary: string;
  details_json: string;
  first_seen_at: string | Date;
  last_seen_at: string | Date;
  resolved_at: string | Date | null;
}

function jsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(jsonValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, jsonValue(entry)]),
    );
  }
  return value;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(jsonValue(value));
}

function parseJson<T>(value: string | T): T {
  return typeof value === 'string' ? (JSON.parse(value) as T) : value;
}

function toIso(value: string | Date): string {
  return new Date(value).toISOString();
}

function changeSummary(row: ChangeRow): LifecycleChangeSummary {
  return lifecycleChangeSummary(row);
}

function lifecycleChangeSummary(row: ChangeRow): LifecycleChangeSummary {
  return {
    changeId: row.id,
    subjectEntityRef: row.subject_entity_ref,
    origin: row.origin as LifecycleChangeSummary['origin'],
    externalChangeKey: row.external_change_key ?? undefined,
    scope: (row.scope ?? 'manual') as LifecycleChangeSummary['scope'],
    externalStatus: (row.external_status ??
      'open') as LifecycleChangeSummary['externalStatus'],
    lastOccurredAt: row.last_occurred_at
      ? toIso(row.last_occurred_at)
      : undefined,
    title: row.title,
    summary: row.summary ?? undefined,
    currentPhase: row.current_phase as LifecycleChangeSummary['currentPhase'],
    currentState: row.current_state as LifecycleChangeSummary['currentState'],
    createdBy: row.created_by,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function runTimestamp(
  run: LifecycleProjection['ciRuns'][number],
  change: LifecycleChangeSummary,
): number {
  return Date.parse(
    run.updatedAt ??
      run.completedAt ??
      change.lastOccurredAt ??
      change.updatedAt,
  );
}

function isMainlineBranch(branch?: string): boolean {
  return Boolean(
    branch &&
      (branch === 'main' ||
        branch === 'master' ||
        branch.startsWith('release-') ||
        branch.startsWith('release/')),
  );
}

function hasSuccessfulMainlineBuild(row: ChangeRow): boolean {
  if (row.scope !== 'branch') return false;
  const projection = lifecycleProjectionSchema.parse(
    parseJson(row.projection_json),
  );
  return projection.ciRuns.some(
    run =>
      isMainlineBranch(run.branch) &&
      run.status === 'completed' &&
      run.conclusion === 'success',
  );
}

function lastSuccessfulPublication(
  rows: ChangeRow[],
): LifecycleSuccessfulPublication | undefined {
  const candidates: Array<{
    change: LifecycleChangeSummary;
    run?: LifecycleProjection['ciRuns'][number];
    artifacts: LifecycleProjection['artifacts'];
    timestamp: number;
  }> = [];

  for (const row of rows) {
    // Offline replay fixtures are regression data only. They must never be
    // promoted into the current live publication summary when a local
    // database is reused for the live profile.
    if (row.origin === 'fixture') continue;
    const change = changeSummary(row);
    const projection = lifecycleProjectionSchema.parse(
      parseJson(row.projection_json),
    );
    const successfulRuns = projection.ciRuns.filter(
      run => run.status === 'completed' && run.conclusion === 'success',
    );
    const winningRun =
      projection.winningRun?.conclusion === 'success'
        ? projection.winningRun
        : undefined;
    const run =
      winningRun ??
      successfulRuns.sort(
        (left, right) =>
          runTimestamp(right, change) - runTimestamp(left, change),
      )[0];
    const artifacts = projection.artifacts.filter(
      artifact =>
        artifact.artifactType === 'npm' ||
        (artifact.artifactType === 'oci' && Boolean(artifact.digest)),
    );
    // A package/image is only a successful publication when it is backed by a
    // completed successful CI run. Never promote an orphaned artifact record
    // to the "last successful" summary.
    if (!run) continue;
    candidates.push({
      change,
      run,
      artifacts,
      timestamp: run ? runTimestamp(run, change) : Date.parse(change.updatedAt),
    });
  }

  const latest = candidates.sort((left, right) => {
    return (
      right.timestamp - left.timestamp ||
      Date.parse(right.change.updatedAt) - Date.parse(left.change.updatedAt)
    );
  })[0];
  return latest
    ? {
        change: latest.change,
        run: latest.run,
        artifacts: latest.artifacts,
      }
    : undefined;
}

function storedEvent(row: EventRow): LifecycleEvent {
  return lifecycleEventSchema.parse({
    eventId: row.event_id,
    eventCursor: String(row.id),
    changeId: row.change_id,
    schemaVersion: row.schema_version,
    occurredAt: toIso(row.occurred_at),
    ingestedAt: toIso(row.ingested_at),
    actorRef: row.actor_ref,
    producer: row.producer,
    payload: parseJson(row.payload_json),
  });
}

function eventIdentity(event: LifecycleEvent): string {
  return canonicalJson({
    eventId: event.eventId,
    changeId: event.changeId,
    schemaVersion: event.schemaVersion,
    // Database drivers normalize timestamps to ISO strings with millisecond
    // precision. Normalize the incoming value as well so equivalent GitHub
    // timestamps (`...Z` and `....000Z`) remain idempotent on retry.
    occurredAt: toIso(event.occurredAt),
    producer: event.producer,
    payload: event.payload,
  });
}

function diagnosticId(input: {
  source: string;
  subjectEntityRef?: string;
  externalId?: string;
  reasonCode: string;
}): string {
  return createHash('sha256')
    .update(
      canonicalJson({
        source: input.source,
        subjectEntityRef: input.subjectEntityRef ?? '',
        externalId: input.externalId ?? '',
        reasonCode: input.reasonCode,
      }),
    )
    .digest('hex');
}

/** @public */
export class LifecycleStore {
  static async create(database: DatabaseService): Promise<LifecycleStore> {
    await migrate(database);
    return new LifecycleStore(await database.getClient());
  }

  constructor(private readonly db: Knex) {}

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
        if (existing.request_payload_json !== requestPayload) {
          throw new ConflictError(
            `Lifecycle identifier was already used with different input`,
          );
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
        const concurrentlyCreated = await trx<ChangeRow>('lifecycle_changes')
          .where({ request_id: input.requestId })
          .first();
        if (!concurrentlyCreated) {
          throw new Error('Concurrent lifecycle change was not persisted');
        }
        if (concurrentlyCreated.request_payload_json !== requestPayload) {
          throw new ConflictError(
            `requestId "${input.requestId}" was already used with different input`,
          );
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
    const now = new Date().toISOString();
    return this.db.transaction(async trx => {
      const existing = await trx('lifecycle_subjects')
        .where({ overlay_entity_ref: input.overlayEntityRef })
        .first();
      const subjectId = existing?.id ?? input.id ?? randomUUID();
      await trx('lifecycle_subjects')
        .insert({
          id: subjectId,
          overlay_entity_ref: input.overlayEntityRef,
          workspace: input.workspace,
          overlay_repository: input.overlayRepository,
          source_repository: input.sourceRepository ?? null,
          source_revision: input.sourceRevision ?? null,
          mapping_status: input.mappingStatus,
          mapping_hash: input.mappingHash,
          first_observed_at: existing?.first_observed_at ?? now,
          last_observed_at: now,
        })
        .onConflict('overlay_entity_ref')
        .merge({
          workspace: input.workspace,
          overlay_repository: input.overlayRepository,
          source_repository: input.sourceRepository ?? null,
          source_revision: input.sourceRevision ?? null,
          mapping_status: input.mappingStatus,
          mapping_hash: input.mappingHash,
          last_observed_at: now,
        });
      const existingBindings = await trx('lifecycle_subject_entities')
        .where({ subject_id: subjectId })
        .select(['entity_ref', 'role', 'first_observed_at']);
      const expectedBindingKeys = new Set(
        input.bindings.map(binding => `${binding.entityRef}:${binding.role}`),
      );
      for (const existingBinding of existingBindings) {
        const key = `${existingBinding.entity_ref}:${existingBinding.role}`;
        if (!expectedBindingKeys.has(key)) {
          await trx('lifecycle_subject_entities')
            .where({
              subject_id: subjectId,
              entity_ref: existingBinding.entity_ref,
              role: existingBinding.role,
            })
            .delete();
        }
      }
      for (const binding of input.bindings) {
        await trx('lifecycle_subject_entities')
          .insert({
            subject_id: subjectId,
            entity_ref: binding.entityRef,
            role: binding.role,
            binding_source: binding.bindingSource,
            status: binding.status,
            first_observed_at: now,
            last_observed_at: now,
          })
          .onConflict(['subject_id', 'entity_ref', 'role'])
          .merge({
            binding_source: binding.bindingSource,
            status: binding.status,
            last_observed_at: now,
          });
      }
      const row = await trx('lifecycle_subjects')
        .where({ id: subjectId })
        .first();
      return this.subjectFromRow(row);
    });
  }

  async getSubjectByEntity(
    entityRef: string,
  ): Promise<LifecycleSubject | undefined> {
    const row = await this.db('lifecycle_subjects as s')
      .join('lifecycle_subject_entities as e', 'e.subject_id', 's.id')
      .where('e.entity_ref', entityRef)
      .select('s.*')
      .first();
    return row ? this.subjectFromRow(row) : undefined;
  }

  async getSubjectBindings(
    subjectId: string,
  ): Promise<LifecycleSubjectBinding[]> {
    const rows = await this.db('lifecycle_subject_entities').where({
      subject_id: subjectId,
    });
    return rows.map(row => ({
      subjectId,
      entityRef: row.entity_ref,
      role: row.role,
      bindingSource: row.binding_source,
      status: row.status,
      firstObservedAt: toIso(row.first_observed_at),
      lastObservedAt: toIso(row.last_observed_at),
    }));
  }

  async getSyncState(subjectId: string): Promise<LifecycleSyncState> {
    const row = await this.db('lifecycle_sync_state')
      .where({ subject_id: subjectId })
      .first();
    return {
      status: row?.status ?? 'never',
      lastAttemptAt: row?.last_attempt_at
        ? toIso(row.last_attempt_at)
        : undefined,
      lastSuccessAt: row?.last_success_at
        ? toIso(row.last_success_at)
        : undefined,
      errorSummary: row?.error_summary ?? undefined,
      rateLimitResetAt: row?.rate_limit_reset_at
        ? toIso(row.rate_limit_reset_at)
        : undefined,
    };
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
    await this.db('lifecycle_sync_state')
      .insert({
        subject_id: subjectId,
        status: state.status,
        last_attempt_at: state.lastAttemptAt ?? null,
        last_success_at: state.lastSuccessAt ?? null,
        error_summary: state.errorSummary ?? null,
        rate_limit_reset_at: state.rateLimitResetAt ?? null,
      })
      .onConflict('subject_id')
      .merge({
        status: state.status,
        last_attempt_at: state.lastAttemptAt ?? null,
        last_success_at: state.lastSuccessAt ?? null,
        error_summary: state.errorSummary ?? null,
        rate_limit_reset_at: state.rateLimitResetAt ?? null,
      });
  }

  async listSubjects(): Promise<LifecycleSubject[]> {
    const rows = await this.db('lifecycle_subjects').orderBy(
      'overlay_entity_ref',
    );
    return rows.map(row => this.subjectFromRow(row));
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

  private subjectFromRow(row: any): LifecycleSubject {
    return {
      id: String(row.id),
      overlayEntityRef: row.overlay_entity_ref,
      workspace: row.workspace,
      overlayRepository: row.overlay_repository,
      sourceRepository: row.source_repository ?? undefined,
      sourceRevision: row.source_revision ?? undefined,
      mappingStatus: row.mapping_status,
      mappingHash: row.mapping_hash,
      firstObservedAt: toIso(row.first_observed_at),
      lastObservedAt: toIso(row.last_observed_at),
    };
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
    const changes = rows.map(changeSummary);
    if (changes.length === 0) {
      if (options.changeId) {
        throw new NotFoundError(
          `Lifecycle change "${options.changeId}" was not found for "${entityRef}"`,
        );
      }
      return { changes, events: [] };
    }

    const selected = options.changeId
      ? rows.find(row => row.id === options.changeId)
      : rows.find(
          row =>
            row.scope === 'pull_request' &&
            row.external_status === 'open' &&
            !['succeeded', 'superseded'].includes(row.current_state),
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
    if (
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
