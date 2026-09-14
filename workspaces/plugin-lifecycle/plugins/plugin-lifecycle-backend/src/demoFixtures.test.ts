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
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  createChangeInputSchema,
  recordEventInputSchema,
} from '@red-hat-developer-hub/backstage-plugin-lifecycle-common';

interface Fixture {
  subjectEntityRef: string;
  title: string;
  summary?: string;
  target?: Record<string, unknown>;
  initialReferences?: unknown[];
  events: Array<{ producer: string; event: Record<string, unknown> }>;
}

describe('demo lifecycle fixtures', () => {
  const fixtureNames = [
    'global-header-events.json',
    'example-analytics-events.json',
  ];

  it.each(fixtureNames)('validates %s against the public contracts', name => {
    const fixture = JSON.parse(
      readFileSync(resolve(__dirname, '../../../demo', name), 'utf8'),
    ) as Fixture;

    expect(() =>
      createChangeInputSchema.parse({
        requestId: `fixture-${name}`,
        subjectEntityRef: fixture.subjectEntityRef,
        title: fixture.title,
        summary: fixture.summary,
        target: fixture.target,
        initialReferences: fixture.initialReferences,
      }),
    ).not.toThrow();
    fixture.events.forEach((entry, index) => {
      recordEventInputSchema.parse({
        eventId: `fixture-${name}-${index}`,
        changeId: '00000000-0000-4000-8000-000000000000',
        occurredAt: '2026-09-01T00:00:00.000Z',
        producer: entry.producer,
        event: entry.event,
      });
    });
  });

  it('covers two independent overlay Component references', () => {
    const refs = fixtureNames.map(name => {
      const fixture = JSON.parse(
        readFileSync(resolve(__dirname, '../../../demo', name), 'utf8'),
      ) as Fixture;
      return fixture.subjectEntityRef;
    });

    expect(new Set(refs).size).toBe(2);
  });
});
