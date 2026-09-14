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
import type { HttpAuthService } from '@backstage/backend-plugin-api';
import { InputError } from '@backstage/errors';
import {
  getContextInputSchema,
  getContextOutputSchema,
} from '@red-hat-developer-hub/backstage-plugin-lifecycle-common';
import express from 'express';
import Router from 'express-promise-router';
import type { LifecycleService } from './service/LifecycleService';

export async function createRouter(options: {
  httpAuth: HttpAuthService;
  service: LifecycleService;
}): Promise<express.Router> {
  const router = Router();
  router.use(express.json({ limit: '16kb' }));

  router.get('/health', (_request, response) => {
    response.json({ status: 'ok' });
  });

  const handleContext = async (
    request: express.Request,
    response: express.Response,
  ) => {
    const credentials = await options.httpAuth.credentials(request, {
      allow: ['user'],
    });
    const pathEntityRef =
      request.params.namespace && request.params.name
        ? `plugin:${request.params.namespace}/${request.params.name}`
        : undefined;
    const parsed = getContextInputSchema.safeParse({
      entityRef:
        pathEntityRef ??
        (typeof request.query.entityRef === 'string'
          ? request.query.entityRef
          : undefined),
      changeId:
        typeof request.query.changeId === 'string'
          ? request.query.changeId
          : undefined,
      asOf:
        typeof request.query.asOf === 'string' ? request.query.asOf : undefined,
      asOfEventId:
        typeof request.query.asOfEventId === 'string'
          ? request.query.asOfEventId
          : undefined,
      eventLimit:
        typeof request.query.eventLimit === 'string'
          ? Number(request.query.eventLimit)
          : undefined,
    });
    if (!parsed.success) {
      throw new InputError(parsed.error.message);
    }
    const context = await options.service.getContext(parsed.data, credentials);
    response.json(getContextOutputSchema.parse(context));
  };

  router.get('/context', handleContext);
  // Compatibility URL for agents and clients that address an Extension
  // Plugin directly. The lifecycle subject remains the associated overlay
  // Component; the service resolves the plugin association from storage.
  router.get('/plugins/:namespace/:name/context', handleContext);

  router.post('/refresh', async (request, response) => {
    const credentials = await options.httpAuth.credentials(request, {
      allow: ['user'],
    });
    const entityRef = request.body?.entityRef;
    if (typeof entityRef !== 'string' || !entityRef) {
      throw new InputError('entityRef is required');
    }
    const context = await options.service.refresh(entityRef, credentials);
    response.json(getContextOutputSchema.parse(context));
  });

  return router;
}
