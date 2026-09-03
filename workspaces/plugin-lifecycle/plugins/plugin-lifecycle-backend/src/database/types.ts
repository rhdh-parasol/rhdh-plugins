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
  EntityRole,
  LifecycleChangeSummary,
  LifecycleEvent,
  LifecycleProjection,
  LifecycleSuccessfulPublication,
} from '@red-hat-developer-hub/backstage-plugin-lifecycle-common';

export interface ChangeAssociation {
  entityRef: string;
  role: EntityRole;
  relationSource: 'subject' | 'catalog-relation' | 'catalog-annotation';
}

export interface CreateChangeOptions {
  origin?: 'action' | 'github-actions' | 'fixture';
  externalChangeKey?: string;
  associations?: ChangeAssociation[];
  scope?: 'pull_request' | 'branch' | 'manual';
  externalStatus?: 'open' | 'merged' | 'closed' | 'published';
  /** External lifecycle time for system-imported changes. Defaults to now. */
  occurredAt?: string;
}

export interface LifecycleSubject {
  id: string;
  overlayEntityRef: string;
  workspace: string;
  overlayRepository: string;
  sourceRepository?: string;
  sourceRevision?: string;
  mappingStatus: 'complete' | 'incomplete' | 'missing';
  mappingHash: string;
  firstObservedAt: string;
  lastObservedAt: string;
}

export interface LifecycleSubjectBinding {
  subjectId: string;
  entityRef: string;
  role: 'source' | 'overlay' | 'extension-plugin' | 'package';
  bindingSource: string;
  status: 'available' | 'missing';
  firstObservedAt: string;
  lastObservedAt: string;
}

export interface LifecycleSyncState {
  status:
    | 'never'
    | 'pending'
    | 'prioritized'
    | 'running'
    | 'succeeded'
    | 'empty'
    | 'failed'
    | 'rate_limited';
  lastAttemptAt?: string;
  lastSuccessAt?: string;
  errorSummary?: string;
  rateLimitResetAt?: string;
}

export interface StoredChange {
  summary: LifecycleChangeSummary;
  projection: LifecycleProjection;
}

export interface StoredChangeDetails extends StoredChange {}

export interface StoredContext {
  changes: LifecycleChangeSummary[];
  selectedChange?: LifecycleChangeSummary;
  projection?: LifecycleProjection;
  lastSuccessfulPublication?: LifecycleSuccessfulPublication;
  events: LifecycleEvent[];
  asOfEventId?: string;
}
