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

import type { GitLabIntegration } from '@backstage/integration';
import type {
  ScmClient,
  ScmProvider,
  ScmProviderContext,
} from '@stepstone-tech/backstage-plugin-ownership-matcher-node';
import { GitLabScmClient } from './GitLabScmClient';
import { GITLAB_TYPE } from './location';

/**
 * Ownership-matcher SCM provider for `integrations.gitlab` hosts. Commit
 * history uses the integration credentials; branch, commit and merge-request
 * calls need `ownershipMatcher.scm.hosts[].writeToken` for the host and are
 * refused (`auth`) without it; they never fall back to the integration's read
 * credentials.
 *
 * @public
 */
export class GitLabScmProvider implements ScmProvider {
  readonly type = GITLAB_TYPE;

  createClient(ctx: ScmProviderContext): ScmClient {
    if (ctx.integration.type !== GITLAB_TYPE) {
      throw new Error(
        `GitLabScmProvider cannot serve a '${ctx.integration.type}' integration`,
      );
    }
    const { config } = ctx.integration as GitLabIntegration;
    const writeToken = ctx.hostConfig?.writeToken;
    if (!writeToken) {
      ctx.logger.warn(
        `No write token for ${config.host} (ownershipMatcher.scm.hosts[].writeToken); branch, commit and merge-request calls are refused for this host`,
      );
    }
    return new GitLabScmClient({
      config,
      writeToken,
      logger: ctx.logger,
      fetch: ctx.fetch,
    });
  }
}
