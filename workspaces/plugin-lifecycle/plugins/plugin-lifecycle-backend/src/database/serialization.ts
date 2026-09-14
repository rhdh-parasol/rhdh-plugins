/*
 * Copyright Red Hat, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 */
import { createHash } from 'crypto';
import {
  lifecycleEventSchema,
  type LifecycleEvent,
} from '@red-hat-developer-hub/backstage-plugin-lifecycle-common';
import type { EventRow } from './rows';

/** Produces stable JSON for idempotency keys and JSON database columns. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(jsonValue(value));
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

export function parseJson<T>(value: string | T): T {
  return typeof value === 'string' ? (JSON.parse(value) as T) : value;
}

export function toIso(value: string | Date): string {
  return new Date(value).toISOString();
}

export function storedEvent(row: EventRow): LifecycleEvent {
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

export function eventIdentity(event: LifecycleEvent): string {
  return canonicalJson({
    eventId: event.eventId,
    changeId: event.changeId,
    schemaVersion: event.schemaVersion,
    // Normalize timestamp precision so equivalent GitHub timestamps remain
    // idempotent when a database driver adds milliseconds.
    occurredAt: toIso(event.occurredAt),
    producer: event.producer,
    payload: event.payload,
  });
}

export function diagnosticId(input: {
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
