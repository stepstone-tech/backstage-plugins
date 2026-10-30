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
import { apiRoot, BitbucketServerScmClient } from './BitbucketServerScmClient';
import { bitbucketServerRepo } from './location';
import {
  AUTHOR,
  createFakeBitbucketServer,
  HOST,
  ORIGIN,
} from './__testUtils__/fakeBitbucketServer';

const server = createFakeBitbucketServer();
const REPO = bitbucketServerRepo(ORIGIN, 'PROJ', 'repo');
const config = {
  host: HOST,
  apiBaseUrl: `${ORIGIN}/rest/api/1.0`,
  token: 'read-token',
};

function makeClient(
  opts: { writeToken?: string | null; fetch?: typeof fetch } = {},
) {
  return new BitbucketServerScmClient({
    config,
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

describe('BitbucketServerScmClient credentials', () => {
  it('reads history with the integration credentials', async () => {
    await makeClient().history.getCommits(REPO, { limit: 5 });
    expect(server.requests[0].headers.Authorization).toBe('Bearer read-token');
  });

  it('runs the whole PR flow, reads included, with the write token', async () => {
    await makeClient().pullRequests.readFile(
      REPO,
      'catalog-info.yaml',
      'master',
    );
    expect(server.requests.map(r => r.headers.Authorization)).toEqual([
      'Bearer write-token',
      'Bearer write-token',
    ]);
  });

  it('refuses the PR flow without a write token — never falls back to the read credentials', async () => {
    const client = makeClient({ writeToken: null });
    const err = await scmError(
      client.pullRequests.createBranch(REPO, 'b', 'master'),
    );
    expect(err).toMatchObject({ kind: 'auth', retryable: false });
    expect(err.message).toMatch(
      /No write token configured for repo.example.com/,
    );
    await expect(
      client.pullRequests.readFile(REPO, 'catalog-info.yaml', 'master'),
    ).rejects.toMatchObject({
      kind: 'auth',
    });
    expect(server.requests).toHaveLength(0);
    // history keeps working on the integration credentials
    await expect(
      client.history.getCommits(REPO, { limit: 1 }),
    ).resolves.toHaveLength(1);
  });
});

describe('BitbucketServerScmClient.history', () => {
  it('maps commits to ScmCommit and respects the limit', async () => {
    const commits = await makeClient().history.getCommits(REPO, { limit: 2 });
    expect(commits).toEqual([
      { id: 'a1', author: { email: 'alice@example.com', name: 'alice' } },
      { id: 'b1', author: { email: 'bob@example.com', name: 'bob' } },
    ]);
    expect(server.requests[0].url.searchParams.get('limit')).toBe('2');
  });

  it('throws on an error response (the strategy turns it into no candidates)', async () => {
    server.fail(/commits/, 503);
    expect(
      (await scmError(makeClient().history.getCommits(REPO, { limit: 5 })))
        .kind,
    ).toBe('unavailable');
  });
});

describe('BitbucketServerScmClient.pullRequests', () => {
  const prs = () => makeClient().pullRequests;

  it('readFile returns content + the last-modifying commit of the file, never the directory commit', async () => {
    await expect(
      prs().readFile(REPO, 'src/My Service/catalog-info.yaml', 'master'),
    ).resolves.toEqual({
      content: 'kind: System\n',
      revision: 'c1',
    });
    expect(server.requests[0].url.pathname).toBe(
      '/rest/api/1.0/projects/PROJ/repos/repo/raw/src/My%20Service/catalog-info.yaml',
    );
    expect(server.requests[1].url.pathname).toBe(
      '/rest/api/1.0/projects/PROJ/repos/repo/last-modified/src/My%20Service',
    );
  });

  it('readFile → undefined on 404, throws when the revision cannot be resolved', async () => {
    await expect(
      prs().readFile(REPO, 'missing.yaml', 'master'),
    ).resolves.toBeUndefined();
    server.fail(/last-modified/, 200);
    server.state.branches
      .get('master')!
      .set('x.yaml', { content: 'x', commit: 'c9' });
    // a 200 whose body is not the expected shape → no revision
    expect(
      (await scmError(prs().readFile(REPO, 'x.yaml', 'master'))).kind,
    ).toBe('unknown');
  });

  it('commitFile sends multipart content/message/branch/sourceCommitId', async () => {
    await prs().commitFile(REPO, 'catalog-info.yaml', {
      content: 'new',
      message: 'msg',
      branch: 'master',
      revision: 'c1',
    });
    expect(server.requests[0]).toMatchObject({
      method: 'PUT',
      body: {
        content: 'new',
        message: 'msg',
        branch: 'master',
        sourceCommitId: 'c1',
      },
    });
  });

  it('commitFile without a revision creates a file; on an existing file it is a conflict', async () => {
    await prs().commitFile(REPO, 'NEW', {
      content: 'n',
      message: 'm',
      branch: 'master',
    });
    expect(server.state.branches.get('master')!.get('NEW')?.content).toBe('n');
    const err = await scmError(
      prs().commitFile(REPO, 'NEW', {
        content: 'n2',
        message: 'm',
        branch: 'master',
      }),
    );
    expect(err).toMatchObject({ kind: 'conflict', httpStatus: 409 });
  });

  it('createBranch posts to branch-utils', async () => {
    await expect(
      prs().createBranch(REPO, 'ownership/x', 'master'),
    ).resolves.toBe('created');
    expect(server.requests[0]).toMatchObject({
      method: 'POST',
      body: { name: 'ownership/x', startPoint: 'master' },
    });
  });

  it('createPullRequest sends refs and reviewers and returns a string id + url', async () => {
    await prs().createBranch(REPO, 'b', 'master');
    const result = await prs().createPullRequest(REPO, {
      title: 't',
      description: 'd',
      fromBranch: 'b',
      toBranch: 'master',
      reviewers: ['JDoe'],
    });
    expect(result).toEqual({
      status: 'created',
      pr: {
        id: '1',
        url: `${ORIGIN}/projects/PROJ/repos/repo/pull-requests/1`,
      },
    });
    expect(server.state.pulls[0]).toMatchObject({
      from: 'b',
      to: 'master',
      reviewers: ['JDoe'],
    });
  });

  it('createPullRequest with an invalid reviewer → invalid (core retries with the acceptor only)', async () => {
    server.fail(/POST .*pull-requests$/, 400, 'svc-account is the author');
    const err = await scmError(
      prs().createPullRequest(REPO, {
        title: 't',
        description: 'd',
        fromBranch: 'b',
        toBranch: 'master',
      }),
    );
    expect(err).toMatchObject({
      kind: 'invalid',
      httpStatus: 400,
      message: 'svc-account is the author',
    });
  });

  it('createPullRequest: a 409 rejecting reviewers is invalid and names them (not a duplicate PR)', async () => {
    await prs().createBranch(REPO, 'b', 'master');
    const err = await scmError(
      prs().createPullRequest(REPO, {
        title: 't',
        description: 'd',
        fromBranch: 'b',
        toBranch: 'master',
        reviewers: ['JDoe', AUTHOR],
      }),
    );
    expect(err).toMatchObject({
      kind: 'invalid',
      httpStatus: 409,
      retryable: false,
      rejectedReviewers: [AUTHOR],
      message: `Errors encountered while adding some reviewers to this pull request. (${AUTHOR}: ${AUTHOR} is the author and cannot be a reviewer.)`,
    });
    expect(server.state.pulls).toHaveLength(0);
  });

  it('createPullRequest: a rejected reviewer whose name looks read-only is still invalid, not read-only', async () => {
    const body = JSON.stringify({
      errors: [
        {
          message:
            'Errors encountered while adding some reviewers to this pull request.',
          exceptionName:
            'com.atlassian.bitbucket.pull.InvalidPullRequestReviewersException',
          reviewerErrors: [
            {
              context: 'archive-bot',
              message: 'archive-bot is not a user with access',
            },
          ],
        },
      ],
    });
    const fetchStub = jest.fn(async () => new Response(body, { status: 409 }));
    const err = await scmError(
      makeClient({
        fetch: fetchStub as typeof fetch,
      }).pullRequests.createPullRequest(REPO, {
        title: 't',
        description: 'd',
        fromBranch: 'b',
        toBranch: 'master',
        reviewers: ['archive-bot'],
      }),
    );
    expect(err).toMatchObject({
      kind: 'invalid',
      rejectedReviewers: ['archive-bot'],
    });
  });

  it('createPullRequest: a 409 without a findable open PR is a conflict', async () => {
    server.fail(/POST .*pull-requests$/, 409, 'duplicate');
    const err = await scmError(
      prs().createPullRequest(REPO, {
        title: 't',
        description: 'd',
        fromBranch: 'b',
        toBranch: 'master',
      }),
    );
    expect(err.kind).toBe('conflict');
  });

  it('updatePullRequest keeps existing reviewers, adds new ones, and is a no-op when nothing differs', async () => {
    await prs().createBranch(REPO, 'b', 'master');
    const { pr } = await prs().createPullRequest(REPO, {
      title: 't',
      description: 'd',
      fromBranch: 'b',
      toBranch: 'master',
      reviewers: ['Lead'],
    });

    await expect(
      prs().updatePullRequest(REPO, pr, {
        title: 't2',
        description: 'd2',
        addReviewers: ['JDOE', 'LEAD'],
      }),
    ).resolves.toBe('updated');
    expect(server.state.pulls[0]).toMatchObject({
      title: 't2',
      description: 'd2',
      reviewers: ['Lead', 'JDOE'],
    });

    await expect(
      prs().updatePullRequest(REPO, pr, {
        title: 't2',
        description: 'd2',
        addReviewers: ['jdoe'],
      }),
    ).resolves.toBe('unchanged');
  });

  it('updatePullRequest surfaces a version conflict', async () => {
    await prs().createBranch(REPO, 'b', 'master');
    const { pr } = await prs().createPullRequest(REPO, {
      title: 't',
      description: 'd',
      fromBranch: 'b',
      toBranch: 'master',
    });
    server.fail(/PUT .*pull-requests\/1$/, 409, 'version mismatch');
    const err = await scmError(
      prs().updatePullRequest(REPO, pr, { title: 'x', description: 'y' }),
    );
    expect(err).toMatchObject({
      kind: 'conflict',
      message: 'version mismatch',
    });
  });

  it('getPullRequest maps state and dates, and a 404 to undefined', async () => {
    await prs().createBranch(REPO, 'b', 'master');
    const { pr } = await prs().createPullRequest(REPO, {
      title: 't',
      description: 'd',
      fromBranch: 'b',
      toBranch: 'master',
    });

    await expect(prs().getPullRequest(REPO, pr.id)).resolves.toEqual({
      ...pr,
      state: 'open',
      createdAt: new Date(Date.UTC(2026, 9, 1)),
    });

    Object.assign(server.state.pulls[0], {
      state: 'MERGED',
      closedDate: Date.UTC(2026, 9, 2),
    });
    await expect(prs().getPullRequest(REPO, pr.id)).resolves.toMatchObject({
      state: 'merged',
      closedAt: new Date(Date.UTC(2026, 9, 2)),
    });

    server.state.pulls[0].state = 'DECLINED';
    await expect(prs().getPullRequest(REPO, pr.id)).resolves.toMatchObject({
      state: 'declined',
    });

    await expect(prs().getPullRequest(REPO, '42')).resolves.toBeUndefined();
  });

  it('getPullRequest throws on an error response or an unknown state', async () => {
    await prs().createBranch(REPO, 'b', 'master');
    const { pr } = await prs().createPullRequest(REPO, {
      title: 't',
      description: 'd',
      fromBranch: 'b',
      toBranch: 'master',
    });

    server.fail(/GET .*pull-requests\/1$/, 503, 'down');
    expect((await scmError(prs().getPullRequest(REPO, pr.id))).kind).toBe(
      'unavailable',
    );

    (server.state.pulls[0] as { state: string }).state = 'SUPERSEDED';
    expect((await scmError(prs().getPullRequest(REPO, pr.id))).kind).toBe(
      'unknown',
    );
  });

  it('resolveReviewer matches the email exactly, case-insensitively', async () => {
    await expect(
      prs().resolveReviewer(REPO, 'jane.doe@example.com'),
    ).resolves.toBe('JDoe');
    await expect(
      prs().resolveReviewer(REPO, 'jane@example.com'),
    ).resolves.toBeUndefined();
  });

  it('createPullRequest with the lowercase slug of a mixed-case user is rejected; the name is accepted', async () => {
    const create = (reviewers: string[]) =>
      prs().createPullRequest(REPO, {
        title: 't',
        description: 'd',
        fromBranch: 'b',
        toBranch: 'master',
        reviewers,
      });
    await expect(create(['jdoe'])).rejects.toMatchObject({
      kind: 'invalid',
      rejectedReviewers: ['jdoe'],
    });
    await expect(create(['JDoe'])).resolves.toMatchObject({
      status: 'created',
    });
  });

  it('a PR opened with resolved acceptor + default reviewers keeps every one, for users whose name differs from their slug', async () => {
    server.state.users.push({
      name: 'SmithA01',
      slug: 'smitha01',
      emailAddress: 'alex.smith@example.com',
    });
    server.state.defaultReviewers.push(
      { name: 'Jane.Roe', slug: 'jane.roe', active: true },
      { name: 'roejx01', slug: 'roejx01', active: true },
    );
    await prs().createBranch(REPO, 'b', 'master');

    const acceptor = await prs().resolveReviewer(
      REPO,
      'Alex.Smith@example.com',
    );
    const defaults = await prs().getDefaultReviewers(REPO, {
      fromBranch: 'b',
      toBranch: 'master',
    });
    expect(acceptor).toBe('SmithA01');
    expect(defaults).toEqual(['Lead', 'Jane.Roe', 'roejx01']);

    const reviewers = [acceptor!, ...defaults];
    await expect(
      prs().createPullRequest(REPO, {
        title: 't',
        description: 'd',
        fromBranch: 'b',
        toBranch: 'master',
        reviewers,
      }),
    ).resolves.toMatchObject({ status: 'created' });
    expect(server.state.pulls[0].reviewers).toEqual([
      'SmithA01',
      'Lead',
      'Jane.Roe',
      'roejx01',
    ]);
  });

  it('falls back to the slug when a user has an empty name', async () => {
    server.state.users.push({
      name: '',
      slug: 'noname',
      emailAddress: 'no.name@example.com',
    });
    server.state.defaultReviewers.push({
      name: '',
      slug: 'blank',
      active: true,
    });

    await expect(
      prs().resolveReviewer(REPO, 'no.name@example.com'),
    ).resolves.toBe('noname');
    await expect(
      prs().getDefaultReviewers(REPO, { fromBranch: 'b', toBranch: 'master' }),
    ).resolves.toContain('blank');
  });

  it('getDefaultReviewers resolves the repo id then the active reviewers for the refs', async () => {
    await expect(
      prs().getDefaultReviewers(REPO, { fromBranch: 'b', toBranch: 'master' }),
    ).resolves.toEqual(['Lead']);
    expect(Object.fromEntries(server.requests[1].url.searchParams)).toEqual({
      sourceRepoId: '77',
      targetRepoId: '77',
      sourceRefId: 'refs/heads/b',
      targetRefId: 'refs/heads/master',
    });
  });

  it('rejects a repo path that is not PROJECT/repo', async () => {
    const err = await scmError(
      prs().getDefaultBranch({ ...REPO, path: 'group/sub/project' }),
    );
    expect(err.kind).toBe('invalid');
  });
});

describe('BitbucketServerScmClient error mapping', () => {
  it.each([
    [401, 'Authentication failed', undefined, 'auth'],
    [403, 'You are not permitted', undefined, 'auth'],
    [403, 'Repository is archived', undefined, 'read-only'],
    [
      400,
      'x',
      'com.atlassian.bitbucket.repository.ArchivedRepositoryException',
      'read-only',
    ],
    [503, 'Bitbucket is in read-only mode', undefined, 'read-only'],
    [404, 'Repository does not exist', undefined, 'not-found'],
    [429, 'Too many requests', undefined, 'rate-limited'],
    [400, 'Bad request', undefined, 'invalid'],
    [
      409,
      'Errors encountered',
      'com.atlassian.bitbucket.pull.InvalidPullRequestReviewersException',
      'invalid',
    ],
    [502, 'Bad gateway', undefined, 'unavailable'],
    [418, 'teapot', undefined, 'unknown'],
  ] as const)(
    'HTTP %s %p (%p) → %s',
    async (status, message, exceptionName, kind) => {
      server.fail(/branch-utils/, status, message, exceptionName);
      const err = await scmError(
        makeClient().pullRequests.createBranch(REPO, 'b', 'master'),
      );
      expect(err).toMatchObject({ kind, httpStatus: status, message });
    },
  );

  it.each([
    [
      'createBranch',
      () => makeClient().pullRequests.createBranch(REPO, 'b', 'master'),
      /branch-utils/,
    ],
    [
      'createPullRequest',
      () =>
        makeClient().pullRequests.createPullRequest(REPO, {
          title: 't',
          description: 'd',
          fromBranch: 'b',
          toBranch: 'master',
        }),
      /POST .*pull-requests$/,
    ],
  ] as const)(
    '%s: a 409 from an archived repo is read-only, not exists/reused',
    async (_op, call, route) => {
      server.fail(
        route,
        409,
        'Repository is archived',
        'com.atlassian.bitbucket.repository.ArchivedRepositoryException',
      );
      expect((await scmError(call())).kind).toBe('read-only');
    },
  );

  it('a network failure or a host outside the allow-list is unavailable', async () => {
    const failing = jest.fn(async () => {
      throw new Error('ECONNRESET');
    });
    const err = await scmError(
      makeClient({
        fetch: failing as typeof fetch,
      }).pullRequests.getDefaultBranch(REPO),
    );
    expect(err).toMatchObject({ kind: 'unavailable', message: 'ECONNRESET' });
  });

  it('an unparseable 2xx body is unknown', async () => {
    const garbage = jest.fn(
      async () => new Response('<html>', { status: 200 }),
    );
    const err = await scmError(
      makeClient({
        fetch: garbage as typeof fetch,
      }).pullRequests.getDefaultBranch(REPO),
    );
    expect(err.kind).toBe('unknown');
  });
});

describe('apiRoot', () => {
  it.each([
    ['https://repo.example.com/rest/api/1.0', 'https://repo.example.com'],
    ['https://repo.example.com/rest/api/1.0/', 'https://repo.example.com'],
    [
      'https://repo.example.com/bitbucket/rest/api/1.0',
      'https://repo.example.com/bitbucket',
    ],
    ['https://api.example.com/custom', 'https://api.example.com'],
  ])('%s → %s', (apiBaseUrl, root) => {
    expect(apiRoot({ host: HOST, apiBaseUrl })).toBe(root);
  });
});
