/* Copyright Red Hat, Inc. */
import type { LifecycleContext } from '@red-hat-developer-hub/backstage-plugin-lifecycle-common';

export const time = '2026-09-01T10:00:00.000Z';
export const changeId = '18163e4e-b0a5-431b-80f1-4913362d9926';
export const context: LifecycleContext = {
  schemaVersion: 2,
  requestedEntityRef: 'component:default/overlay-example',
  subject: {
    entityRef: 'component:default/overlay-example',
    role: 'subject',
    catalogStatus: 'available',
    kind: 'Component',
    name: 'overlay-example',
    namespace: 'default',
    supportedVersions: [],
  },
  relatedEntities: [],
  warnings: [],
  changes: [
    {
      changeId,
      subjectEntityRef: 'component:default/overlay-example',
      origin: 'fixture',
      title: 'Upgrade example plugin',
      currentPhase: 'verification',
      currentState: 'blocked',
      createdBy: 'user:default/tester',
      createdAt: time,
      updatedAt: time,
    },
  ],
  selectedChange: {
    changeId,
    subjectEntityRef: 'component:default/overlay-example',
    origin: 'fixture',
    title: 'Upgrade example plugin',
    currentPhase: 'verification',
    currentState: 'blocked',
    createdBy: 'user:default/tester',
    createdAt: time,
    updatedAt: time,
  },
  projection: {
    phase: 'verification',
    state: 'blocked',
    summary: 'Verification blocked',
    blocker: 'Missing Legacy export',
    references: [],
    ciRuns: [],
    verifications: [],
    artifacts: [],
    agentAttempts: [],
    updatedAt: time,
  },
  events: [
    {
      eventId: 'event-1',
      changeId,
      schemaVersion: 2,
      occurredAt: time,
      ingestedAt: time,
      actorRef: 'user:default/tester',
      producer: 'test',
      payload: {
        kind: 'phase.updated',
        phase: 'verification',
        state: 'blocked',
        summary: 'Verification blocked',
        blocker: 'Missing Legacy export',
      },
    },
  ],
};
