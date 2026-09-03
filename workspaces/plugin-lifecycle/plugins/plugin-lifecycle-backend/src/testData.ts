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
import type {
  CreateChangeOutput,
  LifecycleContext,
  LifecycleEvent,
  LifecycleProjection,
} from '@red-hat-developer-hub/backstage-plugin-lifecycle-common';

export const testChangeId = '18163e4e-b0a5-431b-80f1-4913362d9926';
export const testTime = '2026-09-01T10:00:00.000Z';

export const testProjection: LifecycleProjection = {
  phase: 'intent',
  state: 'pending',
  summary: 'Upgrade plugin',
  references: [],
  ciRuns: [],
  verifications: [],
  artifacts: [],
  agentAttempts: [],
  updatedAt: testTime,
};

export const testCreatedEvent: LifecycleEvent = {
  eventId: `change-created:${testChangeId}`,
  changeId: testChangeId,
  schemaVersion: 2,
  occurredAt: testTime,
  ingestedAt: testTime,
  actorRef: 'user:default/tester',
  producer: 'plugin-lifecycle',
  payload: {
    kind: 'change.created',
    title: 'Upgrade plugin',
    initialReferences: [],
  },
};

export const testCreateOutput: CreateChangeOutput = {
  change: {
    changeId: testChangeId,
    subjectEntityRef: 'component:default/overlay-example',
    origin: 'fixture',
    title: 'Upgrade plugin',
    currentPhase: 'intent',
    currentState: 'pending',
    createdBy: 'user:default/tester',
    createdAt: testTime,
    updatedAt: testTime,
  },
  projection: testProjection,
};

export const testContext: LifecycleContext = {
  schemaVersion: 2,
  requestedEntityRef: 'component:default/overlay-example',
  subject: {
    entityRef: 'component:default/overlay-example',
    role: 'subject',
    catalogStatus: 'available',
    kind: 'Component',
    namespace: 'default',
    name: 'overlay-example',
    supportedVersions: [],
    title: 'Example',
  },
  relatedEntities: [],
  warnings: [],
  changes: [testCreateOutput.change],
  selectedChange: testCreateOutput.change,
  projection: testProjection,
  events: [testCreatedEvent],
};
