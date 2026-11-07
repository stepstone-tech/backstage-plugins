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
import { ownershipMatcherModuleGitLab } from './module';

describe('ownershipMatcherModuleGitLab', () => {
  it('registers the gitlab provider with the ownership-matcher plugin', async () => {
    const logger = mockServices.logger.mock();
    await startTestBackend({
      features: [
        ownershipMatcherPlugin,
        ownershipMatcherModuleGitLab,
        logger.factory,
      ],
    });

    expect(logger.info).toHaveBeenCalledWith(
      'Ownership-matcher SCM providers: gitlab',
    );
    expect(logger.warn).not.toHaveBeenCalledWith(
      expect.stringMatching(/No ownership-matcher SCM provider/),
    );
  });
});
