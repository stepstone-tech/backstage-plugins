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

import { mockServices, startTestBackend } from '@backstage/backend-test-utils';
// Test-only: start the real plugin to check the module registers into it.
// eslint-disable-next-line @backstage/no-mixed-plugin-imports
import { ownershipMatcherPlugin } from '@stepstone-tech/backstage-plugin-ownership-matcher-backend';
import { ownershipMatcherModuleMsGraphEmail } from './module';

const MSGRAPH = {
  tenantId: 'tenant',
  clientId: 'client',
  clientSecret: 'secret',
  userPrincipalName: 'noreply@example.com',
};

async function start(email?: object) {
  const logger = mockServices.logger.mock();
  const scheduler = mockServices.scheduler.mock();
  await startTestBackend({
    features: [
      ownershipMatcherPlugin,
      ownershipMatcherModuleMsGraphEmail,
      logger.factory,
      scheduler.factory,
      mockServices.rootConfig.factory({
        data: {
          app: { baseUrl: 'https://portal.example.com' },
          ...(email ? { ownershipMatcher: { email } } : {}),
        },
      }),
    ],
  });
  const digestScheduled = scheduler.scheduleTask.mock.calls.some(
    ([t]) => (t as { id: string }).id === 'ownership-matcher-email-digest',
  );
  return { logger, digestScheduled };
}

describe('ownershipMatcherModuleMsGraphEmail', () => {
  it('registers the Graph sender so the digest is scheduled', async () => {
    const { logger, digestScheduled } = await start({ msgraph: MSGRAPH });

    expect(logger.info).toHaveBeenCalledWith(
      'Ownership-matcher email sender: Microsoft Graph',
    );
    expect(digestScheduled).toBe(true);
  });

  it('registers nothing when ownershipMatcher.email.msgraph is absent', async () => {
    const { logger, digestScheduled } = await start({});

    expect(logger.info).toHaveBeenCalledWith(
      expect.stringMatching(/Microsoft Graph email sender not registered/),
    );
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringMatching(/no email sender is registered/),
    );
    expect(digestScheduled).toBe(false);
  });

  it('warns about credentials still at the pre-module location', async () => {
    const { logger, digestScheduled } = await start({ ...MSGRAPH });

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringMatching(
        /Ignoring ownershipMatcher\.email\.\{tenantId,clientId,clientSecret,userPrincipalName\}.*moved to ownershipMatcher\.email\.msgraph/,
      ),
    );
    expect(digestScheduled).toBe(false);
  });
});
