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
import { GitLabScmProvider } from './GitLabScmProvider';
import {
  API,
  createFakeGitLabServer,
  HOST,
  ORIGIN,
  PROJECT_PATH,
} from './__testUtils__/fakeGitLabServer';

const server = createFakeGitLabServer();
const integration = ScmIntegrations.fromConfig(
  new ConfigReader({
    integrations: {
      gitlab: [{ host: HOST, apiBaseUrl: API, token: 'read-token' }],
    },
  }),
).byHost(HOST)!;

describeScmProviderConformance(new GitLabScmProvider(), {
  fakeServer: {
    integration,
    hostConfig: { host: HOST, writeToken: 'write-token' },
    fetch: server.fetch,
    reset: server.reset,
    location: {
      url: `${ORIGIN}/${PROJECT_PATH}/-/blob/main/catalog-info.yaml`,
      expected: {
        repo: {
          type: 'gitlab',
          host: HOST,
          path: PROJECT_PATH,
          webUrl: `${ORIGIN}/${PROJECT_PATH}`,
        },
        path: 'catalog-info.yaml',
        ref: 'main',
      },
    },
    unparseableUrl: `${ORIGIN}/${PROJECT_PATH}`,
    baseBranch: 'main',
    async makeRevisionStale(location, branch) {
      server.touch(branch, location.path);
    },
  },
});
