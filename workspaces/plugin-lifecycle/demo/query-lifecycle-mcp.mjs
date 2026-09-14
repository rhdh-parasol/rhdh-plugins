#!/usr/bin/env node
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

const args = process.argv.slice(2);

function option(name, fallback) {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

const localBackend = option('--local-backend');
const configuredServerUrl = option('--server-url');
const entityRef = option(
  '--entity-ref',
  'component:default/overlay-global-header',
);
const changeId = option('--change-id');
const asOf = option('--as-of');
const eventLimit = Number(option('--event-limit', '100'));
const tokenEnvironmentVariable = option('--token-env', 'RHDH_MCP_USER_TOKEN');

if (localBackend && configuredServerUrl) {
  throw new Error('--local-backend and --server-url cannot be used together');
}
if (!localBackend && !configuredServerUrl) {
  throw new Error('provide --local-backend or --server-url');
}
if (!Number.isInteger(eventLimit) || eventLimit < 1 || eventLimit > 500) {
  throw new Error('--event-limit must be an integer from 1 to 500');
}

let serverUrl;
let bearerToken;
if (localBackend) {
  const backendUrl = new URL(localBackend);
  if (!['localhost', '127.0.0.1', '[::1]'].includes(backendUrl.hostname)) {
    throw new Error('--local-backend is restricted to a loopback address');
  }
  serverUrl = new URL('/api/mcp-actions/v1', backendUrl);
  // The example app uses the real guest auth provider. Obtain its short-lived
  // user token instead of sending the test-only token accepted by the backend
  // unit-test harness.
  const authResponse = await fetch(
    new URL('/api/auth/guest/refresh', backendUrl),
    { method: 'POST' },
  );
  if (!authResponse.ok) {
    throw new Error(
      `Unable to obtain local guest credentials: ${authResponse.status}`,
    );
  }
  const auth = await authResponse.json();
  const token = auth.backstageIdentity?.token;
  if (typeof token !== 'string' || token.length === 0) {
    throw new Error('Local guest auth response did not include a token');
  }
  bearerToken = token;
} else {
  serverUrl = new URL(configuredServerUrl);
  bearerToken = process.env[tokenEnvironmentVariable];
  if (!bearerToken) {
    throw new Error(
      `${tokenEnvironmentVariable} must contain an authenticated RHDH user token`,
    );
  }
}

function parseMcpPayload(text, contentType) {
  if (contentType.includes('application/json')) return JSON.parse(text);

  const data = text
    .split(/\r?\n/)
    .filter(line => line.startsWith('data:'))
    .map(line => line.slice('data:'.length).trim())
    .find(Boolean);
  if (!data) {
    throw new Error(`MCP response contained no data event: ${text}`);
  }
  return JSON.parse(data);
}

async function mcpRequest(id, method, params) {
  const response = await fetch(serverUrl, {
    method: 'POST',
    headers: {
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${bearerToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`MCP request failed with ${response.status}: ${text}`);
  }
  const payload = parseMcpPayload(
    text,
    response.headers.get('content-type') ?? '',
  );
  if (payload.error) {
    throw new Error(`MCP error: ${JSON.stringify(payload.error)}`);
  }
  return payload.result;
}

const tools = await mcpRequest(1, 'tools/list', {});
const toolName = 'plugin-lifecycle.get-context';
if (!tools.tools?.some(tool => tool.name === toolName)) {
  throw new Error(
    `${toolName} is not visible. Check backend.actions.pluginSources and the caller's read permission.`,
  );
}

const result = await mcpRequest(2, 'tools/call', {
  name: toolName,
  arguments: {
    entityRef,
    ...(changeId ? { changeId } : {}),
    ...(asOf ? { asOf } : {}),
    eventLimit,
  },
});

if (result.isError) {
  throw new Error(
    result.content
      ?.map(entry => entry.text)
      .filter(Boolean)
      .join('\n') || 'The lifecycle MCP tool returned an error',
  );
}

console.log(JSON.stringify(result.structuredContent, null, 2));
