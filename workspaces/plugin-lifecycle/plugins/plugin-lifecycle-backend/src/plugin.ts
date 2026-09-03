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
  coreServices,
  createBackendPlugin,
} from '@backstage/backend-plugin-api';
import { createHash } from 'crypto';
import {
  DefaultGithubCredentialsProvider,
  ScmIntegrations,
} from '@backstage/integration';
import { actionsRegistryServiceRef } from '@backstage/backend-plugin-api/alpha';
import { catalogServiceRef } from '@backstage/plugin-catalog-node';
import { pluginLifecyclePermissions } from '@red-hat-developer-hub/backstage-plugin-lifecycle-common';
import { createPluginLifecycleActions } from './actions/createActions';
import {
  GitHubActionsCollector,
  GitHubRestActionsReader,
} from './collector/GitHubActionsCollector';
import { LifecycleStore } from './database/LifecycleStore';
import { createRouter } from './router';
import {
  DEFAULT_REFRESH_WAIT_TIMEOUT_MS,
  LifecycleService,
  MAX_REFRESH_WAIT_TIMEOUT_MS,
} from './service/LifecycleService';

/** @public */
export const pluginLifecyclePlugin = createBackendPlugin({
  pluginId: 'plugin-lifecycle',
  register(env) {
    env.registerInit({
      deps: {
        actionsRegistry: actionsRegistryServiceRef,
        auth: coreServices.auth,
        catalog: catalogServiceRef,
        database: coreServices.database,
        httpAuth: coreServices.httpAuth,
        httpRouter: coreServices.httpRouter,
        permissions: coreServices.permissions,
        permissionsRegistry: coreServices.permissionsRegistry,
        rootConfig: coreServices.rootConfig,
        logger: coreServices.logger,
      },
      async init({
        actionsRegistry,
        auth,
        catalog,
        database,
        httpAuth,
        httpRouter,
        permissions,
        permissionsRegistry,
        rootConfig,
        logger,
      }) {
        permissionsRegistry.addPermissions(pluginLifecyclePermissions);
        const store = await LifecycleStore.create(database);
        const configuredRefreshWaitTimeoutMs =
          rootConfig.getOptionalNumber(
            'pluginLifecycle.refreshWaitTimeoutMs',
          ) ?? DEFAULT_REFRESH_WAIT_TIMEOUT_MS;
        const refreshWaitTimeoutMs = Math.max(
          1_000,
          Math.min(
            MAX_REFRESH_WAIT_TIMEOUT_MS,
            Math.floor(configuredRefreshWaitTimeoutMs),
          ),
        );
        const service = new LifecycleService(
          store,
          catalog,
          permissions,
          refreshWaitTimeoutMs,
        );
        createPluginLifecycleActions({ actionsRegistry, service });
        const githubIntegrations = ScmIntegrations.fromConfig(rootConfig);
        const githubActionsEnabled =
          rootConfig.getOptionalBoolean(
            'pluginLifecycle.githubActions.enabled',
          ) ?? false;
        const githubWorkflow =
          rootConfig.getOptionalString(
            'pluginLifecycle.githubActions.workflow',
          ) ?? 'publish-workspace-plugins.yaml';
        // Repository selection is configuration, never a plugin default. A
        // single repository remains supported for backwards compatibility;
        // omitting both keys lets bootstrap discover all mapped overlay
        // Components in the Catalog. Refresh always uses the entity's own
        // github.com/project-slug annotation.
        const configuredRepositories =
          rootConfig.getOptionalStringArray(
            'pluginLifecycle.githubActions.repositories',
          ) ?? [];
        const configuredRepository = rootConfig.getOptionalString(
          'pluginLifecycle.githubActions.repository',
        );
        let githubRepositories: string[] | undefined;
        if (configuredRepositories.length > 0) {
          githubRepositories = [...new Set(configuredRepositories)];
        } else if (configuredRepository) {
          githubRepositories = [configuredRepository];
        }
        const requireManifest =
          rootConfig.getOptionalBoolean(
            'pluginLifecycle.githubActions.requireManifest',
          ) ?? false;
        const closedPullRequestsPerWorkspace =
          rootConfig.getOptionalNumber(
            'pluginLifecycle.githubActions.closedPullRequestsPerWorkspace',
          ) ?? 3;
        let initialCollector: GitHubActionsCollector | undefined;
        if (
          githubActionsEnabled &&
          githubIntegrations.github.list().length > 0
        ) {
          const collector = new GitHubActionsCollector(
            service,
            catalog,
            auth,
            new GitHubRestActionsReader(
              DefaultGithubCredentialsProvider.fromIntegrations(
                githubIntegrations,
              ),
            ),
            logger,
            githubWorkflow,
            requireManifest,
            githubRepositories,
            closedPullRequestsPerWorkspace,
          );
          service.setRefresher(async entityRef =>
            collector.refreshSubject(entityRef),
          );
          initialCollector = collector;
        }
        const ownCredentials = await auth.getOwnServiceCredentials();
        const bootstrapKey = createHash('sha256')
          .update(
            `${
              githubRepositories?.slice().sort().join(',') ?? '*'
            }|${githubWorkflow}|1`,
          )
          .digest('hex');
        service.setBootstrapKey(bootstrapKey);
        void (async () => {
          for (let attempt = 0; attempt < 3; attempt += 1) {
            try {
              await service.reconcileCatalog(ownCredentials);
              if (initialCollector) {
                if (
                  await store.claimBootstrap(
                    bootstrapKey,
                    githubRepositories?.join(',') ?? '*',
                    githubWorkflow,
                  )
                ) {
                  try {
                    const result = await initialCollector.collect();
                    await store.completeBootstrap(
                      bootstrapKey,
                      'completed',
                      result.overlays,
                      result.events,
                    );
                  } catch (error) {
                    await store.completeBootstrap(
                      bootstrapKey,
                      'failed',
                      0,
                      0,
                      error instanceof Error ? error.message : String(error),
                    );
                  }
                }
              }
              return;
            } catch (error) {
              logger.warn(
                `Plugin lifecycle catalog reconciliation attempt ${
                  attempt + 1
                } failed`,
                error as Error,
              );
              if (attempt < 2)
                await new Promise(resolve => setTimeout(resolve, 10_000));
            }
          }
        })();
        httpRouter.use(await createRouter({ httpAuth, service }));
        httpRouter.addAuthPolicy({ path: '/health', allow: 'unauthenticated' });
      },
    });
  },
});
