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

/**
 * In-memory Bitbucket Server REST API covering the endpoints the client uses.
 * `fetch` serves it; `requests` records every call for assertions; `fail`
 * makes the next matching request return an error response.
 */

export const HOST = 'repo.example.com';
export const ORIGIN = `https://${HOST}`;
/** The write token's user — Bitbucket refuses them as a reviewer of their own PR. */
export const AUTHOR = 'svc-writer';

interface FileState {
  content: string;
  commit: string;
}

interface PullRequest {
  id: number;
  from: string;
  to: string;
  title: string;
  description: string;
  reviewers: string[];
  version: number;
  state: 'OPEN' | 'MERGED' | 'DECLINED';
  createdDate: number;
  closedDate?: number;
}

export interface RecordedRequest {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body: unknown;
}

export function createFakeBitbucketServer() {
  let commitCounter = 1;
  const nextCommit = () => `c${++commitCounter}`;
  const defaultUsers = [
    { name: 'JDoe', slug: 'jdoe', emailAddress: 'Jane.Doe@example.com' },
  ];
  const defaultDefaultReviewers: Array<{
    name?: string;
    slug?: string;
    active?: boolean;
  }> = [
    { name: 'Lead', slug: 'lead', active: true },
    { name: 'Gone', slug: 'gone', active: false },
    { active: true },
  ];
  const state = {
    branches: new Map<string, Map<string, FileState>>(),
    pulls: [] as PullRequest[],
    users: [...defaultUsers] as Array<{
      name?: string;
      slug: string;
      emailAddress?: string;
    }>,
    defaultReviewers: [...defaultDefaultReviewers],
    commits: [
      {
        id: 'a1',
        author: { emailAddress: 'alice@example.com', name: 'alice' },
      },
      { id: 'b1', author: { emailAddress: 'bob@example.com', name: 'bob' } },
      {
        id: 'a2',
        author: { emailAddress: 'alice@example.com', name: 'alice' },
      },
    ],
  };
  const requests: RecordedRequest[] = [];
  const failures: Array<{ match: RegExp; status: number; body: string }> = [];

  function reset() {
    commitCounter = 1;
    state.branches = new Map([
      [
        'master',
        new Map([
          ['catalog-info.yaml', { content: 'kind: Component\n', commit: 'c1' }],
          [
            'src/My Service/catalog-info.yaml',
            { content: 'kind: System\n', commit: 'c1' },
          ],
        ]),
      ],
    ]);
    state.pulls = [];
    state.users.splice(0, Infinity, ...defaultUsers);
    state.defaultReviewers.splice(0, Infinity, ...defaultDefaultReviewers);
    requests.length = 0;
    failures.length = 0;
  }
  reset();

  const json = (status: number, body?: unknown) =>
    new Response(body === undefined ? '' : JSON.stringify(body), { status });

  const toJson = (pr: PullRequest) => ({
    id: pr.id,
    version: pr.version,
    title: pr.title,
    description: pr.description,
    reviewers: pr.reviewers.map(name => ({ user: { name } })),
    state: pr.state,
    createdDate: pr.createdDate,
    ...(pr.closedDate ? { closedDate: pr.closedDate } : {}),
    links: {
      self: [
        { href: `${ORIGIN}/projects/PROJ/repos/repo/pull-requests/${pr.id}` },
      ],
    },
  });

  async function readBody(body: unknown): Promise<unknown> {
    if (body instanceof FormData) return Object.fromEntries(body.entries());
    if (typeof body === 'string') return JSON.parse(body);
    return undefined;
  }

  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(
      typeof input === 'string' || input instanceof URL
        ? input.toString()
        : input.url,
    );
    const method = init?.method ?? 'GET';
    const body = await readBody(init?.body);
    requests.push({
      method,
      url,
      headers: { ...(init?.headers as Record<string, string>) },
      body,
    });

    const route = `${method} ${decodeURIComponent(url.pathname)}`;
    const failure = failures.findIndex(f => f.match.test(route));
    if (failure >= 0) {
      const [f] = failures.splice(failure, 1);
      return new Response(f.body, { status: f.status });
    }

    const at =
      url.searchParams.get('at')?.replace(/^refs\/heads\//, '') ?? 'master';
    const api = '/rest/api/1.0/projects/PROJ/repos/repo';
    const path = decodeURIComponent(url.pathname);

    if (method === 'GET' && path === `${api}/commits`) {
      return json(200, { values: state.commits });
    }
    if (method === 'GET' && path === `${api}/default-branch`) {
      return json(200, { id: 'refs/heads/master', displayId: 'master' });
    }
    if (method === 'GET' && path === api) {
      return json(200, { id: 77, slug: 'repo' });
    }
    if (method === 'GET' && path.startsWith(`${api}/raw/`)) {
      const file = state.branches
        .get(at)
        ?.get(path.slice(`${api}/raw/`.length));
      return file
        ? new Response(file.content, { status: 200 })
        : json(404, { errors: [{ message: 'not found' }] });
    }
    if (method === 'GET' && path.startsWith(`${api}/last-modified`)) {
      const dir = path.slice(`${api}/last-modified`.length).replace(/^\//, '');
      const files: Record<string, { id: string }> = {};
      for (const [name, f] of state.branches.get(at) ?? []) {
        const slash = name.lastIndexOf('/');
        if ((slash >= 0 ? name.slice(0, slash) : '') === dir)
          files[name.slice(slash + 1)] = { id: f.commit };
      }
      return json(200, { files, latestCommit: { id: 'dir-latest' } });
    }
    if (method === 'PUT' && path.startsWith(`${api}/browse/`)) {
      const form = body as {
        content: string;
        branch: string;
        sourceCommitId?: string;
      };
      const files = state.branches.get(form.branch);
      if (!files) return json(404, { errors: [{ message: 'no branch' }] });
      const name = path.slice(`${api}/browse/`.length);
      const current = files.get(name);
      if (current && current.commit !== form.sourceCommitId) {
        return json(409, {
          errors: [
            {
              message: 'The file has been modified since',
              exceptionName: 'FileContentModifiedException',
            },
          ],
        });
      }
      if (!current && form.sourceCommitId)
        return json(409, { errors: [{ message: 'file does not exist' }] });
      files.set(name, { content: form.content, commit: nextCommit() });
      return json(200, { id: 'commit' });
    }
    if (
      method === 'POST' &&
      path === '/rest/branch-utils/1.0/projects/PROJ/repos/repo/branches'
    ) {
      const { name, startPoint } = body as { name: string; startPoint: string };
      if (state.branches.has(name))
        return json(409, { errors: [{ message: 'Branch already exists' }] });
      state.branches.set(name, new Map(state.branches.get(startPoint)));
      return json(200, { id: `refs/heads/${name}` });
    }
    if (method === 'GET' && path === `${api}/pull-requests`) {
      const open = state.pulls.filter(p => p.from === at && p.state === 'OPEN');
      return json(200, { values: open.slice(0, 1).map(toJson) });
    }
    if (method === 'POST' && path === `${api}/pull-requests`) {
      const req = body as {
        title: string;
        description: string;
        fromRef: { id: string };
        toRef: { id: string };
        reviewers: Array<{ user: { name: string } }>;
      };
      const from = req.fromRef.id.replace(/^refs\/heads\//, '');
      if (state.pulls.some(p => p.from === from && p.state === 'OPEN')) {
        return json(409, {
          errors: [
            {
              message:
                'Only one pull request may be open for a given source and target branch',
            },
          ],
        });
      }
      // Like Bitbucket, reviewers are looked up by case-sensitive `name`; the
      // lowercase `slug` of a mixed-case user is "not a user".
      const knownUsers = [...state.users, ...state.defaultReviewers].filter(
        u => u.name && u.slug,
      );
      const notAUser = req.reviewers.filter(r =>
        knownUsers.some(
          u => u.slug === r.user.name.toLowerCase() && u.name !== r.user.name,
        ),
      );
      if (notAUser.length) {
        return json(409, {
          errors: [
            {
              context: null,
              message:
                'Errors encountered while adding some reviewers to this pull request.',
              exceptionName:
                'com.atlassian.bitbucket.pull.InvalidPullRequestReviewersException',
              reviewerErrors: notAUser.map(r => ({
                context: r.user.name,
                message: `${r.user.name} is not a user.`,
                exceptionName: null,
              })),
              validReviewers: [],
            },
          ],
        });
      }
      const authorAsReviewer = req.reviewers.find(
        r => r.user.name.toLowerCase() === AUTHOR,
      );
      if (authorAsReviewer) {
        return json(409, {
          errors: [
            {
              context: null,
              message:
                'Errors encountered while adding some reviewers to this pull request.',
              exceptionName:
                'com.atlassian.bitbucket.pull.InvalidPullRequestReviewersException',
              reviewerErrors: [
                {
                  context: authorAsReviewer.user.name,
                  message: `${authorAsReviewer.user.name} is the author and cannot be a reviewer.`,
                  exceptionName: null,
                },
              ],
              validReviewers: [],
            },
          ],
        });
      }
      const pr: PullRequest = {
        id: state.pulls.length + 1,
        from,
        to: req.toRef.id.replace(/^refs\/heads\//, ''),
        title: req.title,
        description: req.description,
        reviewers: req.reviewers.map(r => r.user.name),
        version: 0,
        state: 'OPEN',
        createdDate: Date.UTC(2026, 9, 1),
      };
      state.pulls.push(pr);
      return json(201, toJson(pr));
    }
    const prMatch = new RegExp(`^${api}/pull-requests/(\\d+)$`).exec(path);
    if (prMatch) {
      const pr = state.pulls.find(p => p.id === Number(prMatch[1]));
      if (!pr) return json(404);
      if (method === 'GET') return json(200, toJson(pr));
      const update = body as {
        version: number;
        title: string;
        description: string;
        reviewers: Array<{ user: { name: string } }>;
      };
      if (update.version !== pr.version)
        return json(409, { errors: [{ message: 'version mismatch' }] });
      Object.assign(pr, {
        title: update.title,
        description: update.description,
        reviewers: update.reviewers.map(r => r.user.name),
        version: pr.version + 1,
      });
      return json(200, toJson(pr));
    }
    if (method === 'GET' && path === '/rest/api/1.0/users') {
      return json(200, { values: state.users });
    }
    if (
      method === 'GET' &&
      path === '/rest/default-reviewers/1.0/projects/PROJ/repos/repo/reviewers'
    ) {
      return json(200, state.defaultReviewers);
    }
    return json(404, { errors: [{ message: `no route ${route}` }] });
  };

  return {
    state,
    requests,
    reset,
    fetch: fetchImpl,
    /** Make the next request whose `METHOD /decoded/path` matches return `status` with a Bitbucket error body. */
    fail(
      match: RegExp,
      status: number,
      message = 'boom',
      exceptionName?: string,
    ) {
      failures.push({
        match,
        status,
        body: JSON.stringify({ errors: [{ message, exceptionName }] }),
      });
    },
    /** Change a file on `branch` behind the client's back. */
    touch(branch: string, path: string) {
      const file = state.branches.get(branch)!.get(path)!;
      file.content += '# changed\n';
      file.commit = nextCommit();
    },
  };
}
