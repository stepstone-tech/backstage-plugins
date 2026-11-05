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
import { ownershipMatcherPlugin } from '@stepstone-tech/backstage-plugin-ownership-matcher-backend';
import { createDevScmModule } from './module';
import { MOCK_SCM_TYPE } from './MockScmProvider';

describe('createDevScmModule', () => {
  it('registers the mock provider with the ownership-matcher plugin', async () => {
    const logger = mockServices.logger.mock();

    await startTestBackend({
      features: [
        ownershipMatcherPlugin,
        createDevScmModule({
          rootDir: '/tmp/ownership-matcher-dev-catalog-test',
          host: '127.0.0.1:7008',
          mergeAfterMs: 1000,
        }),
        logger.factory,
      ],
    });

    expect(logger.info).toHaveBeenCalledWith(
      `Ownership-matcher SCM providers: ${MOCK_SCM_TYPE}`,
    );
    expect(logger.warn).not.toHaveBeenCalledWith(
      expect.stringMatching(/No ownership-matcher SCM provider/),
    );
  });
});
