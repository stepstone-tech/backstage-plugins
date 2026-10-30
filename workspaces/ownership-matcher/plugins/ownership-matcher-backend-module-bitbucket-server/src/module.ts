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

import { createBackendModule } from '@backstage/backend-plugin-api';
import { ownershipMatcherScmExtensionPoint } from '@stepstone-tech/backstage-plugin-ownership-matcher-node';
import { BitbucketServerScmProvider } from './BitbucketServerScmProvider';

/**
 * Registers the Bitbucket Server SCM provider with the ownership-matcher plugin.
 *
 * @public
 */
export const ownershipMatcherModuleBitbucketServer = createBackendModule({
  pluginId: 'ownership-matcher',
  moduleId: 'bitbucket-server',
  register(env) {
    env.registerInit({
      deps: { scm: ownershipMatcherScmExtensionPoint },
      async init({ scm }) {
        scm.addProvider(new BitbucketServerScmProvider());
      },
    });
  },
});
