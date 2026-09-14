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
exports.up = async function up(knex) {
  await knex.schema.createTable('lifecycle_changes', table => {
    table.string('id', 36).primary();
    table.string('request_id', 200).notNullable().unique();
    table.text('request_payload_json').notNullable();
    table.string('subject_entity_ref', 512).notNullable();
    table.string('origin', 64).notNullable().defaultTo('action');
    table.string('external_change_key', 1000).nullable().unique();
    table.string('title', 300).notNullable();
    table.text('summary').nullable();
    table.string('current_phase', 32).notNullable();
    table.string('current_state', 32).notNullable();
    table.text('projection_json').notNullable();
    table.string('created_by', 512).notNullable();
    table.timestamp('created_at', { useTz: true }).notNullable();
    table.timestamp('updated_at', { useTz: true }).notNullable();
    table.timestamp('projected_at', { useTz: true }).notNullable();
    table.index(
      ['subject_entity_ref', 'updated_at'],
      'idx_lifecycle_changes_subject_updated',
    );
  });

  await knex.schema.createTable('lifecycle_change_entities', table => {
    table.string('change_id', 36).notNullable();
    table.string('entity_ref', 512).notNullable();
    table.string('role', 32).notNullable();
    table.string('relation_source', 32).notNullable();
    table.timestamp('created_at', { useTz: true }).notNullable();
    table.primary(['change_id', 'entity_ref', 'role']);
    table
      .foreign('change_id')
      .references('id')
      .inTable('lifecycle_changes')
      .onDelete('CASCADE');
    table.index(['entity_ref'], 'idx_lifecycle_change_entities_ref');
    table.index(['change_id'], 'idx_lifecycle_change_entities_change');
  });

  await knex.schema.createTable('lifecycle_events', table => {
    table.bigIncrements('id').primary();
    table.string('event_id', 200).notNullable().unique();
    table
      .string('change_id', 36)
      .notNullable()
      .references('id')
      .inTable('lifecycle_changes')
      .onDelete('CASCADE');
    table.integer('schema_version').notNullable();
    table.string('kind', 64).notNullable();
    table.timestamp('occurred_at', { useTz: true }).notNullable();
    table.timestamp('ingested_at', { useTz: true }).notNullable();
    table.string('actor_ref', 512).notNullable();
    table.string('producer', 200).notNullable();
    table.text('payload_json').notNullable();
    table.index(
      ['change_id', 'occurred_at', 'id'],
      'idx_lifecycle_events_change_time',
    );
  });

  await knex.schema.createTable('lifecycle_ingestion_diagnostics', table => {
    table.string('diagnostic_id', 256).primary();
    table.string('source', 100).notNullable();
    table.string('subject_entity_ref', 512).nullable();
    table.string('external_id', 512).nullable();
    table.string('reason_code', 100).notNullable();
    table.string('summary', 1000).notNullable();
    table.text('details_json').notNullable();
    table.timestamp('first_seen_at', { useTz: true }).notNullable();
    table.timestamp('last_seen_at', { useTz: true }).notNullable();
    table.timestamp('resolved_at', { useTz: true }).nullable();
    table.index(
      ['source', 'external_id'],
      'idx_lifecycle_diagnostics_external',
    );
    table.index(
      ['subject_entity_ref', 'last_seen_at'],
      'idx_lifecycle_diagnostics_subject',
    );
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('lifecycle_ingestion_diagnostics');
  await knex.schema.dropTableIfExists('lifecycle_events');
  await knex.schema.dropTableIfExists('lifecycle_change_entities');
  await knex.schema.dropTableIfExists('lifecycle_changes');
};
