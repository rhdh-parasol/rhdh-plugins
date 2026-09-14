/*
 * Copyright Red Hat, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 */
import { parseEntityRef } from '@backstage/catalog-model';
import type {
  Delivery,
  LifecycleContext,
  LifecycleEvent,
  LifecyclePhase,
  LifecycleProjection,
  LifecycleState,
} from '@red-hat-developer-hub/backstage-plugin-lifecycle-common';

export const phases: Array<{ id: LifecyclePhase; label: string }> = [
  { id: 'intent', label: 'Intent' },
  { id: 'implementation', label: 'Implementation' },
  { id: 'build', label: 'Build' },
  { id: 'verification', label: 'Verification' },
  { id: 'publication', label: 'Publication' },
];

export const stateLabels: Record<LifecycleState, string> = {
  pending: 'Pending',
  running: 'Running',
  blocked: 'Blocked',
  ready_for_human: 'Ready for human',
  failed: 'Failed',
  succeeded: 'Succeeded',
  superseded: 'Superseded',
};

type ChangeExternalStatus = NonNullable<
  LifecycleContext['changes'][number]['externalStatus']
>;

export function externalStatusLabel(
  status?: ChangeExternalStatus,
): string | undefined {
  switch (status) {
    case 'open':
      return 'Open';
    case 'merged':
      return 'Merged';
    case 'closed':
      return 'Closed';
    case 'published':
      return 'Published';
    default:
      return undefined;
  }
}

export function catalogEntityHref(entityRef: string): string {
  const parsed = parseEntityRef(entityRef);
  const kind = parsed.kind.toLocaleLowerCase('en-US');
  if (kind === 'plugin') {
    return `/extensions/plugins/${encodeURIComponent(
      parsed.namespace,
    )}/${encodeURIComponent(parsed.name)}`;
  }
  if (kind === 'package') {
    return `/extensions/packages/${encodeURIComponent(
      parsed.namespace,
    )}/${encodeURIComponent(parsed.name)}`;
  }
  return `/catalog/${parsed.namespace}/${parsed.kind}/${parsed.name}`;
}

export function shortRevision(revision?: string): string | undefined {
  return revision ? revision.slice(0, 12) : undefined;
}

export function publishStatusLabel(
  status: Delivery['activeCandidates'][number]['publishStatus'],
): string {
  switch (status) {
    case 'unknown':
      return 'Publish unknown';
    case 'success':
      return 'Publish succeeded';
    case 'failure':
      return 'Publish failed';
    case 'running':
      return 'Publish running';
    default:
      return 'Publish pending';
  }
}

export function phaseState(
  phase: LifecyclePhase,
  projection: LifecycleProjection,
): LifecycleState | undefined {
  const recorded = projection.phaseStates?.find(entry => entry.phase === phase);
  if (recorded) return recorded.state;
  if (phase !== projection.phase) return undefined;
  return projection.state;
}

export function eventSummary(event: LifecycleEvent): string {
  const payload = event.payload;
  switch (payload.kind) {
    case 'change.created':
      return payload.summary ?? payload.title;
    case 'phase.updated':
      return payload.summary;
    case 'reference.linked':
      return payload.reference.title;
    case 'ci.run.recorded':
      return `${payload.run.workflow} · ${
        payload.run.fixture ? 'fixture run' : 'run'
      } ${payload.run.runId} · attempt ${
        payload.run.runAttempt ?? payload.run.runNumber ?? payload.run.attempt
      }`;
    case 'verification.recorded':
      return payload.verification.summary;
    case 'artifact.recorded':
      return payload.artifact.name ?? payload.artifact.reference;
    case 'agent.attempt.recorded':
      return payload.attempt.summary;
    case 'change.superseded':
      return payload.reason;
    default: {
      const exhaustive: never = payload;
      throw new Error(`Unsupported lifecycle event: ${exhaustive}`);
    }
  }
}

export function eventState(event: LifecycleEvent): LifecycleState | undefined {
  switch (event.payload.kind) {
    case 'phase.updated':
      return event.payload.state;
    case 'verification.recorded':
      return event.payload.verification.state;
    case 'agent.attempt.recorded':
      return event.payload.attempt.state;
    case 'change.superseded':
      return 'superseded';
    case 'ci.run.recorded':
      if (event.payload.run.status !== 'completed') return 'running';
      return event.payload.run.conclusion === 'success'
        ? 'succeeded'
        : 'failed';
    default:
      return undefined;
  }
}

export function eventLink(event: LifecycleEvent): string | undefined {
  switch (event.payload.kind) {
    case 'reference.linked':
      return event.payload.reference.url;
    case 'ci.run.recorded':
      return event.payload.run.url;
    case 'verification.recorded':
      return event.payload.verification.url;
    case 'artifact.recorded':
      return event.payload.artifact.url;
    case 'agent.attempt.recorded':
      return (
        event.payload.attempt.evidenceUrl ?? event.payload.attempt.sessionUrl
      );
    default:
      return undefined;
  }
}

export function eventLinkLabel(event: LifecycleEvent): string {
  switch (event.payload.kind) {
    case 'reference.linked':
      switch (event.payload.reference.type) {
        case 'pull_request':
          return 'Open pull request';
        case 'source':
          return 'Open source revision';
        case 'workflow':
          return 'Open workflow run';
        default:
          return 'Open referenced evidence';
      }
    case 'ci.run.recorded':
      return event.payload.run.provider === 'github-commit-status'
        ? `Open ${event.payload.run.jobName ?? 'GitHub'} check`
        : 'Open workspace job';
    case 'verification.recorded':
      return 'Open verification result';
    case 'artifact.recorded':
      return 'Open artifact';
    case 'agent.attempt.recorded':
      return 'Open agent attempt';
    default:
      return 'Open evidence';
  }
}

export function eventLabel(event: LifecycleEvent): string {
  if (
    event.payload.kind === 'change.created' &&
    event.actorRef === 'system:plugin-lifecycle'
  ) {
    return 'Lifecycle record imported into RHDH';
  }
  const labels: Record<LifecycleEvent['payload']['kind'], string> = {
    'change.created': 'Change created',
    'phase.updated': 'Phase updated',
    'reference.linked': 'Reference linked',
    'ci.run.recorded': 'CI run recorded',
    'verification.recorded': 'Verification recorded',
    'artifact.recorded': 'Artifact recorded',
    'agent.attempt.recorded': 'Agent attempt recorded',
    'change.superseded': 'Change superseded',
  };
  return labels[event.payload.kind];
}

export function formattedTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'medium',
  }).format(new Date(value));
}

export function deliveryStatusLabel(status: Delivery['status']): string {
  switch (status) {
    case 'attention_required':
      return 'Attention required';
    case 'in_progress':
      return 'In progress';
    case 'ready_to_test':
      return 'Ready to test';
    case 'ready_to_merge':
      return 'Ready to merge';
    case 'stable':
      return 'Stable';
    default:
      return 'Unknown';
  }
}

export function shortImageReference(reference: string): string {
  const normalized = reference.replace(/^oci:\/\//, '');
  return `…/${normalized.slice(normalized.lastIndexOf('/') + 1)}`;
}

export function imageReferenceParts(reference: string): {
  name: string;
  version?: string;
} {
  const normalized = reference.replace(/^oci:\/\//, '');
  const leaf = normalized.slice(normalized.lastIndexOf('/') + 1);
  const digestIndex = leaf.indexOf('@');
  const tagIndex = leaf.lastIndexOf(':');
  const separator = digestIndex >= 0 ? digestIndex : tagIndex;
  const rawName = separator >= 0 ? leaf.slice(0, separator) : leaf;
  return {
    name: rawName
      .replace(/^red-hat-developer-hub-backstage-plugin-/, '')
      .replace(/^backstage-community-plugin-/, ''),
    version: separator >= 0 ? leaf.slice(separator + 1) : undefined,
  };
}

export function shortPackageName(packageName: string): string {
  return packageName
    .replace(/^@[^/]+\//, '')
    .replace(/^(backstage-plugin-|rhdh-bsp-)/, '')
    .replace(/^(catalog-backend-module-|catalog-frontend-module-)/, '');
}

export function refreshResultSummary(result: {
  eventsAdded: number;
  changesAdded: number;
}): string {
  if (result.eventsAdded > 0) {
    return `${result.eventsAdded} new event${
      result.eventsAdded === 1 ? '' : 's'
    }`;
  }
  if (result.changesAdded > 0) {
    return `${result.changesAdded} new change${
      result.changesAdded === 1 ? '' : 's'
    }`;
  }
  return 'no new evidence';
}
