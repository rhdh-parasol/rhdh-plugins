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
import { startTestBackend, mockServices } from '@backstage/backend-test-utils';
import { Server } from 'node:net';
import mcpActionsPlugin from '@backstage/plugin-mcp-actions-backend';
import { catalogServiceMock } from '@backstage/plugin-catalog-node/testUtils';
import { AuthorizeResult } from '@backstage/plugin-permission-common';
import request from 'supertest';
import { pluginLifecyclePlugin } from './plugin';

const runningBackends: Array<Awaited<ReturnType<typeof startTestBackend>>> = [];

// backend-test-utils intentionally binds its ephemeral test server to an
// empty host (which Node resolves to 0.0.0.0).  Some constrained CI runners
// disallow wildcard binds, while loopback is sufficient for supertest.
const originalListen = Server.prototype.listen;
beforeAll(() => {
  (Server.prototype as Server & { listen: (...args: any[]) => Server }).listen =
    function patchedListen(this: Server, ...args: any[]) {
      // Node defaults a port-only listen call to 0.0.0.0. Constrained CI
      // runners can reject wildcard binds, so make the test server explicitly
      // loopback-only while preserving callback/options overloads.
      if (typeof args[0] === 'number') {
        if (typeof args[1] === 'function') {
          const callback = args[1];
          args.splice(1, 1, '127.0.0.1', callback);
        } else if (args[1] === undefined || args[1] === '') {
          args[1] = '127.0.0.1';
        }
      } else if (
        args[0] &&
        typeof args[0] === 'object' &&
        (!args[0].host || args[0].host === '0.0.0.0')
      ) {
        args[0] = { ...args[0], host: '127.0.0.1' };
      }
      return originalListen.apply(this, args as never);
    };
});
afterAll(() => {
  Server.prototype.listen = originalListen;
});

function parseMcpResponse(text: string) {
  const dataLine = text.split('\n').find(line => line.startsWith('data: '));
  if (!dataLine) {
    throw new Error(`MCP response did not contain an SSE data event: ${text}`);
  }
  return JSON.parse(dataLine.slice('data: '.length)) as {
    result?: {
      tools?: Array<{
        name: string;
        annotations?: {
          readOnlyHint?: boolean;
          idempotentHint?: boolean;
        };
      }>;
      structuredContent?: Record<string, unknown>;
      isError?: boolean;
      serverInfo?: { name?: string };
      instructions?: string;
    };
    error?: { message: string };
  };
}

function mcpRequest(id: number, method: string, params: object) {
  return {
    jsonrpc: '2.0',
    id,
    method,
    params,
  };
}

async function startBackend(
  permissionResult: AuthorizeResult.ALLOW | AuthorizeResult.DENY,
) {
  const backend = await startTestBackend({
    features: [
      mockServices.rootConfig.factory({
        data: {
          backend: {
            actions: {
              pluginSources: ['plugin-lifecycle'],
              filter: {
                include: [{ id: 'plugin-lifecycle:get-context' }],
              },
            },
          },
          mcpActions: {
            name: 'Plugin Lifecycle integration test',
            instructions:
              'Use plugin-lifecycle.get-context before making plugin decisions.',
          },
        },
      }),
      mockServices.permissions.factory({ result: permissionResult }),
      catalogServiceMock.factory({
        entities: [
          {
            apiVersion: 'backstage.io/v1alpha1',
            kind: 'Component',
            metadata: {
              namespace: 'rhdh',
              name: 'overlay-global-header',
              title: 'Global Header',
            },
            spec: { type: 'rhdh-overlay-workspace' },
          },
        ],
      }),
      pluginLifecyclePlugin,
      mcpActionsPlugin,
    ],
  });
  runningBackends.push(backend);
  return backend;
}

function postMcp(server: Parameters<typeof request>[0], body: object) {
  return request(server)
    .post('/api/mcp-actions/v1')
    .set('Authorization', 'Bearer mock-user-token')
    .set('Accept', 'application/json, text/event-stream')
    .send(body);
}

describe('global Backstage MCP Actions integration', () => {
  afterEach(async () => {
    await Promise.all(runningBackends.splice(0).map(backend => backend.stop()));
  });

  it('initializes the shared server with lifecycle guidance', async () => {
    const backend = await startBackend(AuthorizeResult.ALLOW);
    const response = await postMcp(
      backend.server,
      mcpRequest(0, 'initialize', {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'plugin-lifecycle-test', version: '1.0.0' },
      }),
    ).expect(200);
    const payload = parseMcpResponse(response.text);

    expect(payload.result).toEqual(
      expect.objectContaining({
        serverInfo: expect.objectContaining({
          name: 'Plugin Lifecycle integration test',
        }),
        instructions: expect.stringContaining('plugin-lifecycle.get-context'),
      }),
    );
  });

  it('exposes only the context action as a namespaced MCP tool', async () => {
    const backend = await startBackend(AuthorizeResult.ALLOW);
    const response = await postMcp(
      backend.server,
      mcpRequest(1, 'tools/list', {}),
    ).expect(200);
    const payload = parseMcpResponse(response.text);

    expect(payload.error).toBeUndefined();
    expect(payload.result?.tools).toEqual([
      expect.objectContaining({
        name: 'plugin-lifecycle.get-context',
        annotations: expect.objectContaining({
          readOnlyHint: false,
          idempotentHint: false,
        }),
      }),
    ]);
  });

  it('invokes the existing get-context action through MCP', async () => {
    const backend = await startBackend(AuthorizeResult.ALLOW);
    const response = await postMcp(
      backend.server,
      mcpRequest(2, 'tools/call', {
        name: 'plugin-lifecycle.get-context',
        arguments: {
          entityRef: 'component:rhdh/overlay-global-header',
          eventLimit: 100,
        },
      }),
    ).expect(200);
    const payload = parseMcpResponse(response.text);

    expect(payload.result?.isError).not.toBe(true);
    expect(payload.result?.structuredContent).toEqual(
      expect.objectContaining({
        schemaVersion: 2,
        requestedEntityRef: 'component:rhdh/overlay-global-header',
        subject: expect.objectContaining({
          entityRef: 'component:rhdh/overlay-global-header',
        }),
        changes: [],
        events: [],
      }),
    );
  });

  it('does not expose lifecycle tools when their visibility permission is denied', async () => {
    const backend = await startBackend(AuthorizeResult.DENY);
    const response = await postMcp(
      backend.server,
      mcpRequest(3, 'tools/list', {}),
    ).expect(200);
    const payload = parseMcpResponse(response.text);

    expect(payload.result?.tools).toEqual([]);
  });
});
