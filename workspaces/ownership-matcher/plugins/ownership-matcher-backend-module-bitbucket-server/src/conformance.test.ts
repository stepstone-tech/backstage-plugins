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

import { ConfigReader } from '@backstage/config';
import { ScmIntegrations } from '@backstage/integration';
import { describeScmProviderConformance } from '@stepstone-tech/backstage-plugin-ownership-matcher-node/testUtils';
import { BitbucketServerScmProvider } from './BitbucketServerScmProvider';
import {
  createFakeBitbucketServer,
  HOST,
  ORIGIN,
} from './__testUtils__/fakeBitbucketServer';

const server = createFakeBitbucketServer();
const integration = ScmIntegrations.fromConfig(
  new ConfigReader({
    integrations: {
      bitbucketServer: [
        {
          host: HOST,
          apiBaseUrl: `${ORIGIN}/rest/api/1.0`,
          token: 'read-token',
        },
      ],
    },
  }),
).byHost(HOST)!;

describeScmProviderConformance(new BitbucketServerScmProvider(), {
  fakeServer: {
    integration,
    hostConfig: { host: HOST, writeToken: 'write-token' },
    fetch: server.fetch,
    reset: server.reset,
    location: {
      url: `${ORIGIN}/projects/PROJ/repos/repo/browse/catalog-info.yaml`,
      expected: {
        repo: {
          type: 'bitbucketServer',
          host: HOST,
          path: 'PROJ/repo',
          webUrl: `${ORIGIN}/projects/PROJ/repos/repo/browse`,
        },
        path: 'catalog-info.yaml',
      },
    },
    unparseableUrl: `${ORIGIN}/projects/PROJ/repos/repo/browse`,
    baseBranch: 'master',
    async makeRevisionStale(location, branch) {
      server.touch(branch, location.path);
    },
  },
});
