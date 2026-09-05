/*
 * Copyright Red Hat, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 */
import {
  lifecycleProjectionSchema,
  type LifecycleChangeSummary,
  type LifecycleProjection,
  type LifecycleSuccessfulPublication,
} from '@red-hat-developer-hub/backstage-plugin-lifecycle-common';
import type { ChangeRow } from './rows';
import { parseJson, toIso } from './serialization';

export const MAX_CONTEXT_PR_CHANGES = 25;

export function changeSummary(row: ChangeRow): LifecycleChangeSummary {
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

export function runTimestamp(
  run: LifecycleProjection['ciRuns'][number],
  change: LifecycleChangeSummary,
): number {
  for (const value of [
    run.updatedAt,
    run.completedAt,
    change.lastOccurredAt,
    change.updatedAt,
  ]) {
    if (!value) continue;
    const timestamp = Date.parse(value);
    if (Number.isFinite(timestamp)) return timestamp;
  }
  return 0;
}

export function isMainlineBranch(branch?: string): boolean {
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

/** Selects the latest non-fixture successful publication for the read model. */
export function lastSuccessfulPublication(
  rows: ChangeRow[],
): LifecycleSuccessfulPublication | undefined {
  const candidates: Array<{
    change: LifecycleChangeSummary;
    run?: LifecycleProjection['ciRuns'][number];
    artifacts: LifecycleProjection['artifacts'];
    timestamp: number;
  }> = [];

  for (const row of rows) {
    if (row.origin === 'fixture') continue;
    const change = changeSummary(row);
    const projection = lifecycleProjectionSchema.parse(
      parseJson(row.projection_json),
    );
    const successfulRuns = projection.ciRuns.filter(
      run =>
        !run.fixture &&
        run.status === 'completed' &&
        run.conclusion === 'success',
    );
    const winningRun =
      !projection.winningRun?.fixture &&
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
    if (!run) continue;
    candidates.push({
      change,
      run,
      artifacts,
      timestamp: runTimestamp(run, change),
    });
  }

  const latest = candidates.sort(
    (left, right) =>
      right.timestamp - left.timestamp ||
      Date.parse(right.change.updatedAt) - Date.parse(left.change.updatedAt),
  )[0];
  return latest
    ? { change: latest.change, run: latest.run, artifacts: latest.artifacts }
    : undefined;
}

export { hasSuccessfulMainlineBuild };
