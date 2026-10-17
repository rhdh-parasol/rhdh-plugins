/*
 * Copyright Red Hat, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 */
export interface ChangeRow {
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

export interface EventRow {
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

export interface DiagnosticRow {
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

export interface SubjectRow {
  id: string;
  overlay_entity_ref: string;
  workspace: string;
  overlay_repository: string;
  source_repository: string | null;
  source_revision: string | null;
  mapping_status: 'complete' | 'incomplete' | 'missing';
  mapping_hash: string;
  first_observed_at: string | Date;
  last_observed_at: string | Date;
}
