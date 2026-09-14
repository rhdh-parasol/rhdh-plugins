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

/* Add durable catalog subjects and synchronization state without rewriting history. */
exports.up = async function up(knex) {
  await knex.schema.alterTable('lifecycle_changes', table => {
    table.string('scope', 32).notNullable().defaultTo('manual');
    table.string('external_status', 32).notNullable().defaultTo('open');
    table.timestamp('last_occurred_at', { useTz: true }).nullable();
  });

  await knex.schema.createTable('lifecycle_subjects', table => {
    table.string('id', 36).primary();
    table.string('overlay_entity_ref', 512).notNullable().unique();
    table.string('workspace', 200).notNullable();
    table.string('overlay_repository', 512).notNullable();
    table.string('source_repository', 512).nullable();
    table.string('source_revision', 512).nullable();
    table.string('mapping_status', 32).notNullable().defaultTo('incomplete');
    table.string('mapping_hash', 128).notNullable();
    table.timestamp('first_observed_at', { useTz: true }).notNullable();
    table.timestamp('last_observed_at', { useTz: true }).notNullable();
    table.index(['workspace'], 'idx_lifecycle_subjects_workspace');
  });

  await knex.schema.createTable('lifecycle_subject_entities', table => {
    table.string('subject_id', 36).notNullable();
    table.string('entity_ref', 512).notNullable();
    table.string('role', 32).notNullable();
    table.string('binding_source', 64).notNullable();
    table.string('status', 32).notNullable().defaultTo('available');
    table.timestamp('first_observed_at', { useTz: true }).notNullable();
    table.timestamp('last_observed_at', { useTz: true }).notNullable();
    table.primary(['subject_id', 'entity_ref', 'role']);
    table
      .foreign('subject_id')
      .references('id')
      .inTable('lifecycle_subjects')
      .onDelete('CASCADE');
    table.index(['entity_ref'], 'idx_lifecycle_subject_entities_ref');
  });

  await knex.schema.createTable('lifecycle_sync_state', table => {
    table.string('subject_id', 36).primary();
    table.string('status', 32).notNullable().defaultTo('never');
    table.timestamp('last_attempt_at', { useTz: true }).nullable();
    table.timestamp('last_success_at', { useTz: true }).nullable();
    table.text('error_summary').nullable();
    table.timestamp('rate_limit_reset_at', { useTz: true }).nullable();
    table
      .foreign('subject_id')
      .references('id')
      .inTable('lifecycle_subjects')
      .onDelete('CASCADE');
  });

  await knex.schema.createTable('lifecycle_bootstrap_runs', table => {
    table.string('bootstrap_key', 512).primary();
    table.string('repository', 512).notNullable();
    table.string('workflow', 512).notNullable();
    table.string('manifest_schema_version', 64).notNullable();
    table.string('status', 32).notNullable().defaultTo('running');
    table.timestamp('started_at', { useTz: true }).notNullable();
    table.timestamp('completed_at', { useTz: true }).nullable();
    table.integer('subject_count').notNullable().defaultTo(0);
    table.integer('evidence_count').notNullable().defaultTo(0);
    table.text('error_summary').nullable();
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('lifecycle_bootstrap_runs');
  await knex.schema.dropTableIfExists('lifecycle_sync_state');
  await knex.schema.dropTableIfExists('lifecycle_subject_entities');
  await knex.schema.dropTableIfExists('lifecycle_subjects');
  await knex.schema.alterTable('lifecycle_changes', table => {
    table.dropColumn('scope');
    table.dropColumn('external_status');
    table.dropColumn('last_occurred_at');
  });
};
