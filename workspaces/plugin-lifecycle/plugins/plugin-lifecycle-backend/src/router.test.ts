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
import {
  mockCredentials,
  mockErrorHandler,
  mockServices,
} from '@backstage/backend-test-utils';
import { NotFoundError } from '@backstage/errors';
import express from 'express';
import request from 'supertest';
import type { LifecycleService } from './service/LifecycleService';
import { testContext } from './testData';
import { createRouter } from './router';

describe('Plugin Lifecycle router', () => {
  let app: express.Express;
  let service: jest.Mocked<LifecycleService>;

  beforeEach(async () => {
    service = {
      getContext: jest.fn().mockResolvedValue(testContext),
    } as unknown as jest.Mocked<LifecycleService>;
    app = express();
    app.use(
      await createRouter({
        httpAuth: mockServices.httpAuth(),
        service,
      }),
    );
    app.use(mockErrorHandler());
  });

  it('returns the normalized lifecycle context', async () => {
    const response = await request(app).get(
      '/context?entityRef=component%3Adefault%2Foverlay-example&eventLimit=50',
    );
    expect(response.status).toBe(200);
    expect(response.body).toEqual(testContext);
    expect(service.getContext).toHaveBeenCalledWith(
      expect.objectContaining({
        entityRef: 'component:default/overlay-example',
        eventLimit: 50,
      }),
      expect.anything(),
    );
  });

  it('supports the plugin-shaped compatibility URL', async () => {
    const response = await request(app).get(
      '/plugins/rhdh/global-header/context?eventLimit=50',
    );
    expect(response.status).toBe(200);
    expect(service.getContext).toHaveBeenCalledWith(
      expect.objectContaining({
        entityRef: 'plugin:rhdh/global-header',
        eventLimit: 50,
      }),
      expect.anything(),
    );
  });

  it('rejects invalid historical query parameters', async () => {
    const response = await request(app).get(
      '/context?entityRef=component%3Adefault%2Foverlay-example&eventLimit=999',
    );
    expect(response.status).toBe(400);
  });

  it('passes historical selection to the service and maps missing changes', async () => {
    const historical = await request(app).get(
      `/context?entityRef=component%3Adefault%2Foverlay-example&changeId=${testContext.selectedChange?.changeId}&asOf=2026-09-01T10%3A00%3A00.000Z`,
    );
    expect(historical.status).toBe(200);
    expect(service.getContext).toHaveBeenLastCalledWith(
      expect.objectContaining({
        changeId: testContext.selectedChange?.changeId,
        asOf: '2026-09-01T10:00:00.000Z',
      }),
      expect.anything(),
    );

    service.getContext.mockRejectedValueOnce(
      new NotFoundError('Lifecycle change was not found'),
    );
    const missing = await request(app).get(
      '/context?entityRef=component%3Adefault%2Foverlay-example&changeId=e0068ad4-8f88-4b5c-813b-caad42248010',
    );
    expect(missing.status).toBe(404);
  });

  it('requires an authenticated principal', async () => {
    const response = await request(app)
      .get('/context?entityRef=component%3Adefault%2Foverlay-example')
      .set('Authorization', mockCredentials.none.header());
    expect(response.status).toBe(401);
  });

  it('rejects service credentials for this human-authenticated POC', async () => {
    const response = await request(app)
      .get('/context?entityRef=component%3Adefault%2Foverlay-example')
      .set('Authorization', mockCredentials.service.header());
    expect(response.status).toBe(403);
    expect(service.getContext).not.toHaveBeenCalled();
  });

  it('refreshes a subject and returns the refreshed context', async () => {
    service.refresh = jest.fn().mockResolvedValue(testContext);

    const response = await request(app)
      .post('/refresh')
      .send({ entityRef: 'component:default/overlay-example' });

    expect(response.status).toBe(200);
    expect(response.body).toEqual(testContext);
    expect(service.refresh).toHaveBeenCalledWith(
      'component:default/overlay-example',
      expect.anything(),
    );
  });

  it('rejects a refresh request without an entity reference', async () => {
    service.refresh = jest.fn();

    const response = await request(app).post('/refresh').send({});

    expect(response.status).toBe(400);
    expect(service.refresh).not.toHaveBeenCalled();
  });

  it('requires an authenticated principal for refresh', async () => {
    service.refresh = jest.fn();

    const response = await request(app)
      .post('/refresh')
      .set('Authorization', mockCredentials.none.header())
      .send({ entityRef: 'component:default/overlay-example' });

    expect(response.status).toBe(401);
    expect(service.refresh).not.toHaveBeenCalled();
  });
});
