/*
 * Copyright Red Hat, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 */
import { randomUUID } from 'crypto';
import type { Knex } from 'knex';
import type {
  LifecycleSubject,
  LifecycleSubjectBinding,
  LifecycleSyncState,
} from './types';
import type { SubjectRow } from './rows';
import { toIso } from './serialization';

export interface UpsertSubjectInput {
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
}

/** Persistence operations for Catalog-derived lifecycle subjects and sync state. */
export class SubjectRepository {
  constructor(private readonly db: Knex) {}

  async upsert(input: UpsertSubjectInput): Promise<LifecycleSubject> {
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
        .select(['entity_ref', 'role']);
      const expectedBindingKeys = new Set(
        input.bindings.map(binding => `${binding.entityRef}:${binding.role}`),
      );
      for (const binding of existingBindings) {
        if (!expectedBindingKeys.has(`${binding.entity_ref}:${binding.role}`)) {
          await trx('lifecycle_subject_entities')
            .where({
              subject_id: subjectId,
              entity_ref: binding.entity_ref,
              role: binding.role,
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
      const row = (await trx('lifecycle_subjects')
        .where({ id: subjectId })
        .first()) as SubjectRow | undefined;
      if (!row) throw new Error('Lifecycle subject was not persisted');
      return this.fromRow(row);
    });
  }

  async getByEntity(entityRef: string): Promise<LifecycleSubject | undefined> {
    const subjects = await this.listByEntity(entityRef);
    return subjects[0];
  }

  async listByEntity(entityRef: string): Promise<LifecycleSubject[]> {
    const rows = await this.db('lifecycle_subjects as s')
      .join('lifecycle_subject_entities as e', 'e.subject_id', 's.id')
      .where('e.entity_ref', entityRef)
      .select('s.*')
      .orderBy([
        { column: 's.last_observed_at', order: 'desc' },
        { column: 's.id', order: 'asc' },
      ]);
    const seen = new Set<string>();
    return rows
      .filter(row => {
        if (seen.has(String(row.id))) return false;
        seen.add(String(row.id));
        return true;
      })
      .map(row => this.fromRow(row as SubjectRow));
  }

  async getBindings(subjectId: string): Promise<LifecycleSubjectBinding[]> {
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

  async setSyncState(
    subjectId: string,
    state: LifecycleSyncState,
  ): Promise<void> {
    const existing = await this.db('lifecycle_sync_state')
      .where({ subject_id: subjectId })
      .first();
    const terminalSuccess =
      state.status === 'succeeded' || state.status === 'empty';
    const values = {
      subject_id: subjectId,
      status: state.status,
      last_attempt_at: state.lastAttemptAt ?? existing?.last_attempt_at ?? null,
      last_success_at: state.lastSuccessAt ?? existing?.last_success_at ?? null,
      error_summary:
        state.errorSummary ??
        (terminalSuccess ? null : existing?.error_summary ?? null),
      rate_limit_reset_at:
        state.rateLimitResetAt ??
        (state.status === 'rate_limited'
          ? existing?.rate_limit_reset_at ?? null
          : null),
    };
    await this.db('lifecycle_sync_state')
      .insert(values)
      .onConflict('subject_id')
      .merge(values);
  }

  async list(): Promise<LifecycleSubject[]> {
    const rows = await this.db('lifecycle_subjects').orderBy(
      'overlay_entity_ref',
    );
    return rows.map(row => this.fromRow(row as SubjectRow));
  }

  private fromRow(row: SubjectRow): LifecycleSubject {
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
}
