/*
 * Copyright 2026 The Stepstone Group
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
  createBackendModule,
} from '@backstage/backend-plugin-api';
import { ownershipMatcherNotifierExtensionPoint } from '@stepstone-tech/backstage-plugin-ownership-matcher-node';
import { MsGraphEmailSender } from './MsGraphEmailSender';

const LEGACY_KEYS = [
  'tenantId',
  'clientId',
  'clientSecret',
  'userPrincipalName',
];

/**
 * Registers a Microsoft Graph email sender for the ownership-matcher email
 * digest, configured by `ownershipMatcher.email.msgraph`.
 */
export const ownershipMatcherModuleMsGraphEmail = createBackendModule({
  pluginId: 'ownership-matcher',
  moduleId: 'msgraph-email',
  register(env) {
    env.registerInit({
      deps: {
        notifier: ownershipMatcherNotifierExtensionPoint,
        config: coreServices.rootConfig,
        logger: coreServices.logger,
      },
      async init({ notifier, config, logger }) {
        const msgraphConfig = config.getOptionalConfig(
          'ownershipMatcher.email.msgraph',
        );
        const legacyKeys = LEGACY_KEYS.filter(key =>
          config.has(`ownershipMatcher.email.${key}`),
        );
        if (legacyKeys.length > 0) {
          // Before this module existed these keys sat directly under
          // ownershipMatcher.email; they are now ignored.
          logger.warn(
            `Ignoring ownershipMatcher.email.{${legacyKeys.join(
              ',',
            )}}: Microsoft Graph settings ` +
              'moved to ownershipMatcher.email.msgraph',
          );
        }
        if (!msgraphConfig) {
          logger.info(
            'Microsoft Graph email sender not registered — set ownershipMatcher.email.msgraph to enable',
          );
          return;
        }
        notifier.setEmailSender(
          MsGraphEmailSender.fromConfig(msgraphConfig, logger),
        );
        logger.info('Ownership-matcher email sender: Microsoft Graph');
      },
    });
  },
});
