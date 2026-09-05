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

import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

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

const instance = option('--instance');
const localBackend = option('--local-backend');
const delayMs = Number(option('--delay-ms', '2500'));
const fixtureFile = option('--fixture', './global-header-events.json');
const dryRun = args.includes('--dry-run');
if (instance && localBackend) {
  throw new Error('--instance and --local-backend cannot be used together');
}
if (!Number.isFinite(delayMs) || delayMs < 0) {
  throw new Error('--delay-ms must be a non-negative number');
}
if (localBackend) {
  const endpoint = new URL(localBackend);
  if (!['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname)) {
    throw new Error('--local-backend is restricted to a loopback address');
  }
}

const fixture = JSON.parse(
  await readFile(new URL(fixtureFile, import.meta.url), 'utf8'),
);
const fixtureSlug = fixture.subjectEntityRef
  .replace(/^[^:]+:/, '')
  .replace(/[^a-zA-Z0-9]+/g, '-')
  .replace(/^-|-$/g, '');
const replayId = `${fixtureSlug}-${Date.now()}`;
let localAuthorization = 'Bearer mock-user-token';

if (localBackend) {
  const authResponse = await fetch(
    new URL('/api/auth/guest/refresh', localBackend),
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
  localAuthorization = `Bearer ${token}`;
}

function actionArgs(actionId, input) {
  const result = ['yarn', 'backstage-cli', 'actions', 'execute', actionId];
  if (instance) result.push('--instance', instance);
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined) continue;
    result.push(
      `--${key}`,
      typeof value === 'string' ? value : JSON.stringify(value),
    );
  }
  return result;
}

async function execute(actionId, input) {
  const commandArgs = actionArgs(actionId, input);
  if (dryRun) {
    console.log(
      `corepack ${commandArgs.map(value => JSON.stringify(value)).join(' ')}`,
    );
    return {};
  }
  if (localBackend) {
    const pluginId = actionId.slice(0, actionId.indexOf(':'));
    const actionUrl = new URL(
      `/api/${encodeURIComponent(
        pluginId,
      )}/.backstage/actions/v1/actions/${encodeURIComponent(actionId)}/invoke`,
      localBackend,
    );
    const response = await fetch(actionUrl, {
      method: 'POST',
      headers: {
        authorization: localAuthorization,
        'content-type': 'application/json',
      },
      body: JSON.stringify(input),
    });
    if (!response.ok) {
      throw new Error(
        `${actionId} failed with ${response.status}: ${await response.text()}`,
      );
    }
    return (await response.json()).output;
  }
  const result = spawnSync('corepack', commandArgs, {
    cwd: new URL('..', import.meta.url),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  if (result.status !== 0) {
    throw new Error(`${actionId} failed with exit code ${result.status}`);
  }
  return JSON.parse(result.stdout);
}

const sleep = milliseconds =>
  new Promise(resolve => setTimeout(resolve, milliseconds));

function assess(context) {
  const projection = context.projection;
  const successfulVerification = projection?.verifications.some(
    verification => verification.state === 'succeeded',
  );
  const packageArtifact = projection?.artifacts.find(
    artifact => artifact.artifactType === 'npm' && artifact.version,
  );
  const ociArtifact = projection?.artifacts.find(
    artifact => artifact.artifactType === 'oci' && artifact.digest,
  );
  const ready = Boolean(
    projection?.phase === 'publication' &&
      projection.state === 'succeeded' &&
      !projection.blocker &&
      projection.winningRun?.conclusion === 'success' &&
      successfulVerification &&
      packageArtifact &&
      ociArtifact,
  );
  return {
    decision: ready ? 'GO' : 'NO-GO',
    phase: projection?.phase,
    state: projection?.state,
    blocker: projection?.blocker,
    evidence: {
      sourceSha: projection?.winningRun?.commitSha,
      winningRun: projection?.winningRun?.runId,
      winningRunIsFixture: projection?.winningRun?.fixture,
      packageVersion: packageArtifact?.version,
      ociDigest: ociArtifact?.digest,
      successfulVerification: Boolean(successfulVerification),
    },
  };
}

async function readAndAssess(label, changeId) {
  const context = await execute('plugin-lifecycle:get-context', {
    entityRef: fixture.subjectEntityRef,
    changeId,
    eventLimit: 100,
  });
  if (!dryRun) {
    console.log(`${label}: ${JSON.stringify(assess(context), null, 2)}`);
  }
  return context;
}

console.log(
  `Starting lifecycle replay for ${fixture.subjectEntityRef} (${replayId})`,
);
await readAndAssess('Context before replay');
const created = await execute('plugin-lifecycle:create-change', {
  requestId: replayId,
  subjectEntityRef: fixture.subjectEntityRef,
  title: fixture.title,
  summary: fixture.summary,
  target: fixture.target,
  initialReferences: fixture.initialReferences,
});
const changeId = dryRun
  ? '00000000-0000-4000-8000-000000000000'
  : created.change.changeId;
console.log(`Created change ${changeId}`);

for (const [index, entry] of fixture.events.entries()) {
  if (index > 0 && !dryRun) await sleep(delayMs);
  console.log(`[${index + 1}/${fixture.events.length}] ${entry.event.kind}`);
  await execute('plugin-lifecycle:record-event', {
    eventId: `${replayId}:${String(index + 1).padStart(2, '0')}`,
    changeId,
    occurredAt: new Date().toISOString(),
    producer: entry.producer,
    event: entry.event,
  });
  if (
    entry.event.kind === 'phase.updated' &&
    entry.event.phase === 'verification' &&
    entry.event.state === 'blocked'
  ) {
    await readAndAssess('Context while verification is blocked', changeId);
  }
}

await readAndAssess('Context after replay', changeId);
console.log(`Replay complete. Query change ${changeId} through RHDH.`);
