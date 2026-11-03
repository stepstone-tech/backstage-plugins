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

import type {
  ScmClient,
  ScmCommit,
  ScmFileLocation,
  ScmHistoryCapability,
  ScmProvider,
  ScmProviderContext,
  ScmRepoRef,
} from '@stepstone-tech/backstage-plugin-ownership-matcher-node';
import { DEV_PROJECT_KEY } from '../devScmServer';
import { MockPrStore } from './MockPrStore';
import { COMMIT_AUTHORS } from './fixtures';

/**
 * The integration type the dev SCM server's host is configured as. Backstage
 * only accepts its built-in integration types, so the mock borrows one; nothing
 * here talks to a real server.
 */
export const MOCK_SCM_TYPE = 'bitbucketServer';

/** The only file name that is a component's catalog location. */
const CATALOG_INFO = 'catalog-info.yaml';

const BROWSE_PATH = /^\/projects\/([^/]+)\/repos\/([^/]+)\/browse\/(.+)$/;

/** @see MockScmProvider */
export interface MockScmProviderOptions {
  /** The dev SCM server's writable copy, from `startDevScmServer`. */
  rootDir: string;
  /** Host the catalog is served on, e.g. `127.0.0.1:7008`. */
  host: string;
  /** How long a pull request stays open before it merges itself. */
  mergeAfterMs: number;
}

/**
 * `http://<host>/projects/dev/repos/<slug>/browse/catalog-info.yaml` → the
 * component's file location. Anything else — another host, `org.yaml`, a
 * string that is not a URL at all — is `undefined` rather than an error: the
 * same registry resolves users and groups, and a throw there kills the scan.
 */
export function parseDevLocation(
  url: string,
  host: string,
): ScmFileLocation | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (parsed.host !== host) return undefined;

  const match = BROWSE_PATH.exec(parsed.pathname);
  if (!match) return undefined;

  let projectKey: string;
  let repoSlug: string;
  let path: string;
  try {
    [projectKey, repoSlug, path] = match.slice(1, 4).map(decodeURIComponent);
  } catch {
    return undefined;
  }
  if (projectKey !== DEV_PROJECT_KEY || path !== CATALOG_INFO) return undefined;

  return {
    repo: {
      type: MOCK_SCM_TYPE,
      host,
      path: `${projectKey}/${repoSlug}`,
      webUrl: `${parsed.origin}/projects/${projectKey}/repos/${repoSlug}/browse`,
    },
    path,
  };
}

/**
 * Commit history straight out of `fixtures.ts`. A repo with no fixture has no
 * commits, which is how a component is kept out of `top-contributor`'s reach.
 */
const mockHistory: ScmHistoryCapability = {
  async getCommits(
    repo: ScmRepoRef,
    opts: { limit: number },
  ): Promise<ScmCommit[]> {
    const slug = repoSlugOf(repo.path);
    const authors = slug ? COMMIT_AUTHORS[repo.path] ?? [] : [];
    return authors
      .slice(0, opts.limit)
      .map((author, index) => ({ id: `${slug}-${index + 1}`, author }));
  },
};

/** `dev/orphaned-service` → `orphaned-service`; anything else is not a dev repo. */
export function repoSlugOf(repoPath: string): string | undefined {
  const parts = repoPath.split('/');
  return parts.length === 2 && parts[0] === DEV_PROJECT_KEY && parts[1]
    ? parts[1]
    : undefined;
}

/**
 * Dev-only SCM provider for the catalog served by `startDevScmServer`.
 *
 * It registers for `MOCK_SCM_TYPE`, the integration type the served host is
 * configured as. No real provider for that type is installed in the dev
 * backend, so there is no collision. Nothing here talks to a network: history
 * is a fixture and pull requests live in memory.
 */
export class MockScmProvider implements ScmProvider {
  readonly type = MOCK_SCM_TYPE;

  /** One store for the whole provider: pull requests must outlive a client. */
  private readonly prStore: MockPrStore;

  constructor(private readonly options: MockScmProviderOptions) {
    this.prStore = new MockPrStore({
      rootDir: options.rootDir,
      mergeAfterMs: options.mergeAfterMs,
    });
  }

  createClient(_ctx: ScmProviderContext): ScmClient {
    const { host } = this.options;
    return {
      parseLocation: url => parseDevLocation(url, host),
      history: mockHistory,
      pullRequests: this.prStore,
    };
  }
}
