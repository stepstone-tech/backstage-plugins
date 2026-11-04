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

import { mockServices } from '@backstage/backend-test-utils';
import {
  isScmError,
  type ScmError,
} from '@stepstone-tech/backstage-plugin-ownership-matcher-node';
import { GitLabScmClient } from './GitLabScmClient';
import { gitlabRepo } from './location';
import {
  API,
  createFakeGitLabServer,
  HOST,
  ORIGIN,
  PROJECT_PATH,
} from './__testUtils__/fakeGitLabServer';

const server = createFakeGitLabServer();
const REPO = gitlabRepo(ORIGIN, PROJECT_PATH);

function makeClient(
  opts: {
    writeToken?: string | null;
    token?: string | null;
    fetch?: typeof fetch;
  } = {},
) {
  return new GitLabScmClient({
    config: {
      host: HOST,
      apiBaseUrl: API,
      baseUrl: ORIGIN,
      ...(opts.token === null ? {} : { token: opts.token ?? 'read-token' }),
    },
    writeToken:
      opts.writeToken === null ? undefined : opts.writeToken ?? 'write-token',
    logger: mockServices.logger.mock(),
    fetch: opts.fetch ?? server.fetch,
  });
}

async function scmError(promise: Promise<unknown>): Promise<ScmError> {
  const err = await promise.then(
    () => undefined,
    e => e,
  );
  if (!isScmError(err))
    throw new Error(`expected an ScmError, got ${String(err)}`);
  return err;
}

beforeEach(() => server.reset());

describe('GitLabScmClient credentials', () => {
  it('reads history with the integration token', async () => {
    await makeClient().history.getCommits(REPO, { limit: 5 });
    expect(server.requests[0].headers.Authorization).toBe('Bearer read-token');
  });

  it('runs the merge-request flow, reads included, with the write token', async () => {
    await makeClient().pullRequests.readFile(REPO, 'catalog-info.yaml', 'main');
    expect(server.requests.map(r => r.headers.Authorization)).toEqual([
      'Bearer write-token',
    ]);
  });

  it('refuses the merge-request flow without a write token — never falls back to the read credentials', async () => {
    const client = makeClient({ writeToken: null });
    const err = await scmError(client.pullRequests.getDefaultBranch(REPO));
    expect(err.kind).toBe('auth');
    expect(err.message).toContain('writeToken');
    expect(server.requests).toHaveLength(0);
  });

  it('reads history anonymously without any token', async () => {
    const client = makeClient({ writeToken: null, token: null });
    await expect(
      client.history.getCommits(REPO, { limit: 5 }),
    ).resolves.toHaveLength(3);
    expect(server.requests[0].headers.Authorization).toBeUndefined();
  });

  it('maps network failures to `unavailable`', async () => {
    const client = makeClient({
      fetch: async () => {
        throw new Error('ECONNRESET');
      },
    });
    const err = await scmError(client.history.getCommits(REPO, { limit: 1 }));
    expect(err.kind).toBe('unavailable');
  });
});

describe('GitLabScmClient history', () => {
  const manyCommits = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      id: `c${i}`,
      author_email: `dev${i % 5}@example.com`,
      author_name: `dev${i % 5}`,
    }));

  it('maps author_email and author_name, newest first', async () => {
    await expect(
      makeClient().history.getCommits(REPO, { limit: 25 }),
    ).resolves.toEqual([
      { id: 'a1', author: { email: 'alice@example.com', name: 'alice' } },
      { id: 'b1', author: { email: 'bob@example.com', name: 'bob' } },
      { id: 'a2', author: { email: 'alice@example.com', name: 'alice' } },
    ]);
    const url = server.requests[0].url;
    expect(url.pathname).toBe(
      `/api/v4/projects/${encodeURIComponent(PROJECT_PATH)}/repository/commits`,
    );
    expect(url.searchParams.get('per_page')).toBe('25');
  });

  it('passes per_page from the limit (GitLab defaults to 20)', async () => {
    server.state.commits = manyCommits(40);
    const commits = await makeClient().history.getCommits(REPO, { limit: 30 });
    expect(commits).toHaveLength(30);
    expect(server.requests).toHaveLength(1);
    expect(server.requests[0].url.searchParams.get('per_page')).toBe('30');
  });

  it('pages through limits above 100', async () => {
    server.state.commits = manyCommits(300);
    const commits = await makeClient().history.getCommits(REPO, {
      limit: 250,
    });
    expect(commits).toHaveLength(250);
    expect(commits[249].id).toBe('c249');
    expect(
      server.requests.map(r => [
        r.url.searchParams.get('per_page'),
        r.url.searchParams.get('page'),
      ]),
    ).toEqual([
      ['100', '1'],
      ['100', '2'],
      ['100', '3'],
    ]);
  });

  it('stops at the last page', async () => {
    server.state.commits = manyCommits(150);
    const commits = await makeClient().history.getCommits(REPO, {
      limit: 500,
    });
    expect(commits).toHaveLength(150);
    expect(server.requests).toHaveLength(2);
  });

  it('stops on a short page when GitLab sends no x-next-page header', async () => {
    server.state.commits = manyCommits(150);
    server.state.nextPageHeader = false;
    const commits = await makeClient().history.getCommits(REPO, {
      limit: 500,
    });
    expect(commits).toHaveLength(150);
    expect(server.requests).toHaveLength(2);
  });

  it('throws `not-found` for a missing project', async () => {
    server.fail(/repository\/commits/, 404, '404 Project Not Found');
    const err = await scmError(
      makeClient().history.getCommits(REPO, { limit: 5 }),
    );
    expect(err.kind).toBe('not-found');
  });
});

describe('GitLabScmClient files and branches', () => {
  it('reads a file, decoding base64, with last_commit_id as the revision', async () => {
    await expect(
      makeClient().pullRequests.readFile(
        REPO,
        'src/My Service/catalog-info.yaml',
        'main',
      ),
    ).resolves.toEqual({ content: 'kind: System\n', revision: 'c1' });
    const url = server.requests[0].url;
    expect(url.pathname).toContain(
      `/repository/files/${encodeURIComponent(
        'src/My Service/catalog-info.yaml',
      )}`,
    );
    expect(url.searchParams.get('ref')).toBe('main');
  });

  it('returns undefined for a missing file or branch', async () => {
    const prs = makeClient().pullRequests;
    await expect(prs.readFile(REPO, 'nope.yaml', 'main')).resolves.toBe(
      undefined,
    );
    await expect(
      prs.readFile(REPO, 'catalog-info.yaml', 'no-branch'),
    ).resolves.toBeUndefined();
  });

  it('updates a file with PUT and last_commit_id', async () => {
    const prs = makeClient().pullRequests;
    await prs.commitFile(REPO, 'catalog-info.yaml', {
      content: 'kind: Component\nspec: {}\n',
      message: 'update owner',
      branch: 'main',
      revision: 'c1',
    });
    const req = server.requests[0];
    expect(req.method).toBe('PUT');
    expect(req.body).toEqual({
      branch: 'main',
      content: 'kind: Component\nspec: {}\n',
      commit_message: 'update owner',
      last_commit_id: 'c1',
    });
    await expect(
      prs.readFile(REPO, 'catalog-info.yaml', 'main'),
    ).resolves.toMatchObject({ content: 'kind: Component\nspec: {}\n' });
  });

  it('creates a missing file with POST and no revision', async () => {
    const prs = makeClient().pullRequests;
    await prs.commitFile(REPO, 'new/catalog-info.yaml', {
      content: 'kind: Component\n',
      message: 'add',
      branch: 'main',
    });
    expect(server.requests[0].method).toBe('POST');
    expect(server.requests[0].body).not.toHaveProperty('last_commit_id');
  });

  it('reports creating a file that already exists as `conflict`', async () => {
    const err = await scmError(
      makeClient().pullRequests.commitFile(REPO, 'catalog-info.yaml', {
        content: 'x',
        message: 'add',
        branch: 'main',
      }),
    );
    expect(err.kind).toBe('conflict');
  });

  it('creates a branch and reports an existing one as `exists`', async () => {
    const prs = makeClient().pullRequests;
    await expect(prs.createBranch(REPO, 'feature/x', 'main')).resolves.toBe(
      'created',
    );
    expect(server.requests[0].body).toEqual({
      branch: 'feature/x',
      ref: 'main',
    });
    await expect(prs.createBranch(REPO, 'feature/x', 'main')).resolves.toBe(
      'exists',
    );
  });

  it('throws `read-only` instead of `exists` for an archived project', async () => {
    server.fail(
      /POST .*repository\/branches/,
      403,
      'This project is archived and cannot be modified',
    );
    const err = await scmError(
      makeClient().pullRequests.createBranch(REPO, 'feature/x', 'main'),
    );
    expect(err.kind).toBe('read-only');
  });

  it('reads the default branch', async () => {
    server.state.defaultBranch = 'trunk';
    await expect(
      makeClient().pullRequests.getDefaultBranch(REPO),
    ).resolves.toBe('trunk');
  });

  it('rejects an empty project path as `invalid`', async () => {
    const err = await scmError(
      makeClient().pullRequests.getDefaultBranch({ ...REPO, path: 'a//b' }),
    );
    expect(err.kind).toBe('invalid');
  });
});

describe('GitLabScmClient merge requests', () => {
  const opts = {
    title: 'Set owner',
    description: 'Ownership',
    fromBranch: 'feature/owner',
    toBranch: 'main',
  };

  beforeEach(async () => {
    await makeClient().pullRequests.createBranch(REPO, opts.fromBranch, 'main');
    server.requests.length = 0;
  });

  it('creates an MR with reviewer ids and returns iid + web_url', async () => {
    const { status, pr } = await makeClient().pullRequests.createPullRequest(
      REPO,
      { ...opts, reviewers: ['7', '7'] },
    );
    expect(status).toBe('created');
    expect(pr).toEqual({
      id: '1',
      url: `${ORIGIN}/${PROJECT_PATH}/-/merge_requests/1`,
    });
    expect(server.requests[0].body).toEqual({
      source_branch: 'feature/owner',
      target_branch: 'main',
      title: 'Set owner',
      description: 'Ownership',
      reviewer_ids: [7],
    });
  });

  it('rejects non-numeric reviewer ids as `invalid`, naming them', async () => {
    const err = await scmError(
      makeClient().pullRequests.createPullRequest(REPO, {
        ...opts,
        reviewers: ['7', 'jdoe'],
      }),
    );
    expect(err.kind).toBe('invalid');
    expect(err.rejectedReviewers).toEqual(['jdoe']);
    expect(server.requests).toHaveLength(0);
  });

  it('ignores a fork MR with the same source branch name', async () => {
    server.addForkMergeRequest(opts.fromBranch);
    const prs = makeClient().pullRequests;
    await expect(
      prs.findOpenPullRequest(REPO, opts.fromBranch),
    ).resolves.toBeUndefined();
    const created = await prs.createPullRequest(REPO, opts);
    expect(created.status).toBe('created');
    await expect(
      prs.findOpenPullRequest(REPO, opts.fromBranch),
    ).resolves.toEqual(created.pr);
  });

  it.each([
    ['opened', 'open', undefined],
    ['locked', 'open', undefined],
    ['merged', 'merged', '2026-10-02T00:00:00.000Z'],
    ['closed', 'declined', '2026-10-02T00:00:00.000Z'],
  ] as const)('maps state %s to %s', async (gitlabState, state, closedAt) => {
    const prs = makeClient().pullRequests;
    const { pr } = await prs.createPullRequest(REPO, opts);
    server.setMergeRequestState(Number(pr.id), gitlabState);
    const read = await prs.getPullRequest(REPO, pr.id);
    expect(read).toEqual({
      ...pr,
      state,
      createdAt: new Date('2026-10-01T00:00:00.000Z'),
      ...(closedAt ? { closedAt: new Date(closedAt) } : {}),
    });
  });

  it('throws on an unknown MR state', async () => {
    const prs = makeClient().pullRequests;
    const { pr } = await prs.createPullRequest(REPO, opts);
    server.setMergeRequestState(Number(pr.id), 'weird' as any);
    const err = await scmError(prs.getPullRequest(REPO, pr.id));
    expect(err.kind).toBe('unknown');
  });

  it('updates title, description and adds reviewers, keeping existing ones', async () => {
    server.state.users.push({ id: 8, username: 'other', state: 'active' });
    const prs = makeClient().pullRequests;
    const { pr } = await prs.createPullRequest(REPO, {
      ...opts,
      reviewers: ['7'],
    });
    server.requests.length = 0;

    await expect(
      prs.updatePullRequest(REPO, pr, {
        title: 'New title',
        description: 'New description',
        addReviewers: ['7', '8'],
      }),
    ).resolves.toBe('updated');
    expect(server.requests[1].method).toBe('PUT');
    expect(server.requests[1].body).toEqual({
      title: 'New title',
      description: 'New description',
      reviewer_ids: [7, 8],
    });
  });

  it('leaves reviewers untouched when none are added', async () => {
    const prs = makeClient().pullRequests;
    const { pr } = await prs.createPullRequest(REPO, opts);
    server.requests.length = 0;
    await prs.updatePullRequest(REPO, pr, {
      title: 'New title',
      description: opts.description,
      addReviewers: [],
    });
    expect(server.requests[1].body).not.toHaveProperty('reviewer_ids');
  });

  it('reports `unchanged` without writing when nothing differs', async () => {
    const prs = makeClient().pullRequests;
    const { pr } = await prs.createPullRequest(REPO, {
      ...opts,
      reviewers: ['7'],
    });
    server.requests.length = 0;
    await expect(
      prs.updatePullRequest(REPO, pr, {
        title: opts.title,
        description: opts.description,
        addReviewers: ['7'],
      }),
    ).resolves.toBe('unchanged');
    expect(server.requests.map(r => r.method)).toEqual(['GET']);
  });
});

describe('GitLabScmClient reviewers', () => {
  it('resolves a user by public email, case-insensitively', async () => {
    await expect(
      makeClient().pullRequests.resolveReviewer(REPO, 'jane.doe@example.com'),
    ).resolves.toBe('7');
    expect(server.requests[0].url.searchParams.get('search')).toBe(
      'jane.doe@example.com',
    );
  });

  it('accepts a single active hit when no email is returned', async () => {
    server.state.users = [{ id: 9, username: 'sam', state: 'active' }];
    const fetchWithSearchHit: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === '/api/v4/users')
        return new Response(JSON.stringify(server.state.users), {
          status: 200,
        });
      return server.fetch(input, init);
    };
    await expect(
      makeClient({ fetch: fetchWithSearchHit }).pullRequests.resolveReviewer(
        REPO,
        'sam@example.com',
      ),
    ).resolves.toBe('9');
  });

  it('returns undefined for ambiguous, blocked or missing users', async () => {
    const respond =
      (users: unknown[]): typeof fetch =>
      async () =>
        new Response(JSON.stringify(users), { status: 200 });
    const resolve = (users: unknown[]) =>
      makeClient({ fetch: respond(users) }).pullRequests.resolveReviewer(
        REPO,
        'x@example.com',
      );
    await expect(resolve([])).resolves.toBeUndefined();
    await expect(
      resolve([
        { id: 1, state: 'active' },
        { id: 2, state: 'active' },
      ]),
    ).resolves.toBeUndefined();
    await expect(
      resolve([{ id: 1, state: 'blocked', public_email: 'x@example.com' }]),
    ).resolves.toBeUndefined();
  });

  it('rejects a single hit that matched by name rather than email', async () => {
    const resolve = (users: unknown[]) =>
      makeClient({
        fetch: async () => new Response(JSON.stringify(users), { status: 200 }),
      }).pullRequests.resolveReviewer(REPO, 'x@example.com');
    await expect(
      resolve([{ id: 1, state: 'active', name: 'Mail X@Example.com' }]),
    ).resolves.toBeUndefined();
    await expect(
      resolve([{ id: 2, state: 'active', name: 'Xavier', username: 'xav' }]),
    ).resolves.toBe('2');
  });

  it('returns active approvers of rules that apply to the target branch', async () => {
    const prs = makeClient().pullRequests;
    await expect(
      prs.getDefaultReviewers(REPO, { fromBranch: 'f', toBranch: 'main' }),
    ).resolves.toEqual(['11']);
    await expect(
      prs.getDefaultReviewers(REPO, {
        fromBranch: 'f',
        toBranch: 'release/1.0',
      }),
    ).resolves.toEqual(['11', '13']);
  });

  it('returns no default reviewers when approval rules are unavailable', async () => {
    server.state.approvalRulesAvailable = false;
    await expect(
      makeClient().pullRequests.getDefaultReviewers(REPO, {
        fromBranch: 'f',
        toBranch: 'main',
      }),
    ).resolves.toEqual([]);
  });

  it('propagates other approval-rule failures', async () => {
    server.fail(/approval_rules/, 500, 'Internal Server Error');
    const err = await scmError(
      makeClient().pullRequests.getDefaultReviewers(REPO, {
        fromBranch: 'f',
        toBranch: 'main',
      }),
    );
    expect(err.kind).toBe('unavailable');
  });
});
