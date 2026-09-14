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

import { RELATION_DEPENDENCY_OF } from '@backstage/catalog-model';

export function isLifecycleEntity(entity: {
  kind: string;
  spec?: { type?: string };
  relations?: Array<{ type: string; targetRef: string }>;
}): boolean {
  if (entity.kind.toLocaleLowerCase('en-US') !== 'component') return false;
  if (entity.spec?.type === 'rhdh-overlay-workspace') return true;
  return (entity.relations ?? []).some(
    relation =>
      relation.type === RELATION_DEPENDENCY_OF &&
      // Source Components are eligible through the generated reverse
      // dependency relation. Do not assume overlay names use an `overlay-`
      // prefix; workspace names are user-defined.
      relation.targetRef.toLocaleLowerCase('en-US').startsWith('component:'),
  );
}
