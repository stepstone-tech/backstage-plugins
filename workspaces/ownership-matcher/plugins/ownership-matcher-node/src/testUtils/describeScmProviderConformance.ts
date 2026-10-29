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

/* eslint-disable jest/no-export -- a test-utility library: it exports a function that registers jest blocks for provider modules */
import type { LoggerService } from '@backstage/backend-plugin-api';
import type { ScmIntegration } from '@backstage/integration';
import {
  createRestrictedFetch,
  integrationHosts,
} from '../scm/restrictedFetch';
import { isScmError } from '../scm/ScmError';
import type {
  ScmClient,
  ScmFileLocation,
  ScmHostConfig,
  ScmProvider,
} from '../scm/types';

const silentLogger: LoggerService = {
  error() {},
  warn() {},
  info() {},
  debug() {},
  child: () => silentLogger,
};

/**
 * A fake SCM server the conformance suite runs a provider against. The
 * provider must make every request through `ScmProviderContext.fetch`; the
 * suite routes those to {@link ScmConformanceFakeServer.fetch} and makes the
 * global `fetch` throw while a test runs.
 *
 * @public
 */
export interface ScmConformanceFakeServer {
  /** The integration the fake server impersonates (its host + API base URL). */
  integration: ScmIntegration;
  hostConfig?: ScmHostConfig;
  /** Serves the provider's requests (e.g. an in-memory router, or a nock/msw-backed fetch). */
  fetch: typeof fetch;
  /** Reset server state; called before each test. */
  reset?(): void | Promise<void>;
  /** A `managed-by-location` URL (without `url:`) to an existing file, and how it must parse. */
  location: { url: string; expected: ScmFileLocation };
  /** A URL on the integration host that is not a file location (e.g. the repo root). */
  unparseableUrl: string;
  /** An existing branch in `location.expected.repo` to branch from. */
  baseBranch: string;
  /** Change the file on `branch` behind the provider's back, making earlier revisions stale. */
  makeRevisionStale(location: ScmFileLocation, branch: string): Promise<void>;
}

/** @public */
export interface ScmProviderConformanceOptions {
  fakeServer: ScmConformanceFakeServer;
}

/**
 * Registers a jest `describe` block that checks a provider against the
 * ownership-matcher SCM contract: location parsing, the host-restricted
 * `fetch`, and — when the client has the capability — branch/PR idempotency
 * (`exists` / `reused`) and conflict on a stale revision.
 *
 * @public
 */
export function describeScmProviderConformance(
  provider: ScmProvider,
  { fakeServer }: ScmProviderConformanceOptions,
): void {
  describe(`SCM provider conformance: ${provider.type}`, () => {
    const requestedHosts: string[] = [];
    let client: ScmClient;
    let originalFetch: typeof fetch;

    const allowedHosts = () => integrationHosts(fakeServer.integration);

    beforeEach(async () => {
      await fakeServer.reset?.();
      requestedHosts.length = 0;
      originalFetch = globalThis.fetch;
      globalThis.fetch = (async () => {
        throw new Error(
          'SCM providers must use ScmProviderContext.fetch, not the global fetch',
        );
      }) as typeof fetch;

      const recording: typeof fetch = async (input, init) => {
        const url =
          typeof input === 'string' || input instanceof URL
            ? input.toString()
            : input.url;
        requestedHosts.push(new URL(url).host);
        return fakeServer.fetch(input, init);
      };
      client = await provider.createClient({
        integration: fakeServer.integration,
        hostConfig: fakeServer.hostConfig,
        logger: silentLogger,
        fetch: createRestrictedFetch(allowedHosts(), recording),
      });
    });

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    it('has a type matching the integration it serves', () => {
      expect(provider.type).toBe(fakeServer.integration.type);
    });

    it('parses a managed-by-location URL into a file location', () => {
      expect(client.parseLocation(fakeServer.location.url)).toEqual(
        fakeServer.location.expected,
      );
    });

    it('returns undefined for a URL that is not a file location', () => {
      expect(client.parseLocation(fakeServer.unparseableUrl)).toBeUndefined();
    });

    it('rejects requests outside the integration host', async () => {
      const ctxFetch = createRestrictedFetch(allowedHosts(), fakeServer.fetch);
      await expect(ctxFetch('https://evil.example.invalid/x')).rejects.toThrow(
        /allowed-hosts/,
      );
      await expect(ctxFetch('file:///etc/passwd')).rejects.toThrow(/scheme/);
    });

    const repo = () => fakeServer.location.expected.repo;
    const filePath = () => fakeServer.location.expected.path;

    it('only talks to the integration host', async () => {
      if (client.history) await client.history.getCommits(repo(), { limit: 5 });
      if (client.pullRequests)
        await client.pullRequests.getDefaultBranch(repo());
      expect(requestedHosts.length).toBeGreaterThan(0);
      for (const host of requestedHosts) expect(allowedHosts()).toContain(host);
    });

    it('returns at most `limit` commits (history)', async () => {
      if (!client.history) return;
      const commits = await client.history.getCommits(repo(), { limit: 1 });
      expect(commits.length).toBeLessThanOrEqual(1);
      for (const c of commits) {
        expect(typeof c.id).toBe('string');
        expect(typeof c.author.email).toBe('string');
      }
    });

    it('reads an existing file with a revision and a missing one as undefined (pullRequests)', async () => {
      const prs = client.pullRequests;
      if (!prs) return;
      const file = await prs.readFile(
        repo(),
        filePath(),
        fakeServer.baseBranch,
      );
      expect(file).toEqual({
        content: expect.any(String),
        revision: expect.any(String),
      });
      await expect(
        prs.readFile(
          repo(),
          `${filePath()}.does-not-exist`,
          fakeServer.baseBranch,
        ),
      ).resolves.toBeUndefined();
    });

    it('reports an existing branch as `exists` (pullRequests)', async () => {
      const prs = client.pullRequests;
      if (!prs) return;
      const branch = 'conformance/branch';
      await expect(
        prs.createBranch(repo(), branch, fakeServer.baseBranch),
      ).resolves.toBe('created');
      await expect(
        prs.createBranch(repo(), branch, fakeServer.baseBranch),
      ).resolves.toBe('exists');
    });

    it('throws a `conflict` ScmError when committing on a stale revision (pullRequests)', async () => {
      const prs = client.pullRequests;
      if (!prs) return;
      const branch = 'conformance/conflict';
      await prs.createBranch(repo(), branch, fakeServer.baseBranch);
      const file = await prs.readFile(repo(), filePath(), branch);
      await fakeServer.makeRevisionStale(fakeServer.location.expected, branch);

      const error = await prs
        .commitFile(repo(), filePath(), {
          content: `${file!.content}\n# conformance\n`,
          message: 'conformance',
          branch,
          revision: file!.revision,
        })
        .then(
          () => undefined,
          e => e,
        );
      expect(isScmError(error)).toBe(true);
      expect(error.kind).toBe('conflict');
    });

    it('reports a second PR from the same branch as `reused` (pullRequests)', async () => {
      const prs = client.pullRequests;
      if (!prs) return;
      const branch = 'conformance/pr';
      await prs.createBranch(repo(), branch, fakeServer.baseBranch);
      const file = await prs.readFile(repo(), filePath(), branch);
      await prs.commitFile(repo(), filePath(), {
        content: `${file!.content}\n# conformance\n`,
        message: 'conformance',
        branch,
        revision: file!.revision,
      });
      const opts = {
        title: 'Conformance',
        description: 'Conformance',
        fromBranch: branch,
        toBranch: fakeServer.baseBranch,
      };

      const first = await prs.createPullRequest(repo(), opts);
      expect(first.status).toBe('created');
      const second = await prs.createPullRequest(repo(), opts);
      expect(second).toEqual({ status: 'reused', pr: first.pr });
      await expect(prs.findOpenPullRequest(repo(), branch)).resolves.toEqual(
        first.pr,
      );
      await expect(
        prs.findOpenPullRequest(repo(), 'conformance/none'),
      ).resolves.toBeUndefined();
    });

    it('reads a PR back by id, and an unknown id as undefined (pullRequests)', async () => {
      const prs = client.pullRequests;
      if (!prs) return;
      const branch = 'conformance/get-pr';
      await prs.createBranch(repo(), branch, fakeServer.baseBranch);
      const file = await prs.readFile(repo(), filePath(), branch);
      await prs.commitFile(repo(), filePath(), {
        content: `${file!.content}\n# conformance\n`,
        message: 'conformance',
        branch,
        revision: file!.revision,
      });
      const { pr } = await prs.createPullRequest(repo(), {
        title: 'Conformance',
        description: 'Conformance',
        fromBranch: branch,
        toBranch: fakeServer.baseBranch,
      });

      await expect(prs.getPullRequest(repo(), pr.id)).resolves.toMatchObject({
        ...pr,
        state: 'open',
      });
      await expect(
        prs.getPullRequest(repo(), '999999'),
      ).resolves.toBeUndefined();
    });
  });
}
