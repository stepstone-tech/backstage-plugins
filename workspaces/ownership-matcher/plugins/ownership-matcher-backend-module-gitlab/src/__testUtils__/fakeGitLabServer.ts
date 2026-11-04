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
 * In-memory GitLab REST v4 API covering the endpoints the client uses, for
 * the project `acme/platform/repo`. `fetch` serves it; `requests` records
 * every call for assertions; `fail` makes the next matching request return an
 * error response.
 */

export const HOST = 'gitlab.example.com';
export const ORIGIN = `https://${HOST}`;
export const API = `${ORIGIN}/api/v4`;
export const PROJECT_PATH = 'acme/platform/repo';
const PROJECT_ID = 42;

interface FileState {
  content: string;
  commit: string;
}

interface MergeRequest {
  iid: number;
  sourceBranch: string;
  targetBranch: string;
  sourceProjectId: number;
  title: string;
  description: string;
  reviewerIds: number[];
  state: 'opened' | 'merged' | 'closed' | 'locked';
  createdAt: string;
  mergedAt?: string;
  closedAt?: string;
}

interface User {
  id: number;
  username: string;
  state: string;
  public_email?: string;
}

interface ApprovalRule {
  rule_type: string;
  eligible_approvers?: Array<{ id: number; username: string; state: string }>;
  protected_branches?: Array<{ name: string }>;
  applies_to_all_protected_branches?: boolean;
}

export interface RecordedRequest {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body: unknown;
}

const defaultUsers: User[] = [
  {
    id: 7,
    username: 'jdoe',
    state: 'active',
    public_email: 'Jane.Doe@example.com',
  },
];

const defaultApprovalRules: ApprovalRule[] = [
  {
    rule_type: 'regular',
    eligible_approvers: [
      { id: 11, username: 'lead', state: 'active' },
      { id: 12, username: 'gone', state: 'blocked' },
    ],
    protected_branches: [],
  },
  {
    rule_type: 'regular',
    eligible_approvers: [{ id: 13, username: 'release-lead', state: 'active' }],
    protected_branches: [{ name: 'release/*' }],
  },
  {
    rule_type: 'any_approver',
    eligible_approvers: [{ id: 14, username: 'anyone', state: 'active' }],
  },
];

export function createFakeGitLabServer() {
  let commitCounter = 1;
  const nextCommit = () => `c${++commitCounter}`;
  const state = {
    defaultBranch: 'main',
    branches: new Map<string, Map<string, FileState>>(),
    mrs: [] as MergeRequest[],
    users: [] as User[],
    approvalRules: [] as ApprovalRule[],
    /** `false`: approval rules unavailable (Free tier) → 403. */
    approvalRulesAvailable: true,
    commits: [] as Array<{
      id: string;
      author_email: string;
      author_name: string;
    }>,
    /** Whether commit pages carry `x-next-page`. */
    nextPageHeader: true,
  };
  const requests: RecordedRequest[] = [];
  const failures: Array<{ match: RegExp; status: number; body: string }> = [];

  function reset() {
    commitCounter = 1;
    state.defaultBranch = 'main';
    state.branches = new Map([
      [
        'main',
        new Map([
          ['catalog-info.yaml', { content: 'kind: Component\n', commit: 'c1' }],
          [
            'src/My Service/catalog-info.yaml',
            { content: 'kind: System\n', commit: 'c1' },
          ],
        ]),
      ],
    ]);
    state.mrs = [];
    state.users = defaultUsers.map(u => ({ ...u }));
    state.approvalRules = defaultApprovalRules.map(r => ({ ...r }));
    state.approvalRulesAvailable = true;
    state.commits = [
      { id: 'a1', author_email: 'alice@example.com', author_name: 'alice' },
      { id: 'b1', author_email: 'bob@example.com', author_name: 'bob' },
      { id: 'a2', author_email: 'alice@example.com', author_name: 'alice' },
    ];
    state.nextPageHeader = true;
    requests.length = 0;
    failures.length = 0;
  }
  reset();

  const json = (
    status: number,
    body?: unknown,
    headers: Record<string, string> = {},
  ) =>
    new Response(body === undefined ? '' : JSON.stringify(body), {
      status,
      headers,
    });

  const userJson = (id: number) => {
    const user = state.users.find(u => u.id === id);
    return { id, username: user?.username ?? `user${id}`, state: 'active' };
  };

  const toJson = (mr: MergeRequest) => ({
    iid: mr.iid,
    project_id: PROJECT_ID,
    source_project_id: mr.sourceProjectId,
    target_project_id: PROJECT_ID,
    source_branch: mr.sourceBranch,
    target_branch: mr.targetBranch,
    title: mr.title,
    description: mr.description,
    state: mr.state,
    created_at: mr.createdAt,
    merged_at: mr.mergedAt ?? null,
    closed_at: mr.closedAt ?? null,
    reviewers: mr.reviewerIds.map(userJson),
    web_url: `${ORIGIN}/${PROJECT_PATH}/-/merge_requests/${mr.iid}`,
  });

  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(
      typeof input === 'string' || input instanceof URL
        ? input.toString()
        : input.url,
    );
    const method = init?.method ?? 'GET';
    const body =
      typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    requests.push({
      method,
      url,
      headers: { ...(init?.headers as Record<string, string>) },
      body,
    });

    // Decode per segment: `%2F` inside a segment (project id, file path) stays
    // part of that segment, as on GitLab.
    const segments = url.pathname.split('/').map(decodeURIComponent);
    const route = `${method} ${segments.join('/')}`;
    const failure = failures.findIndex(f => f.match.test(route));
    if (failure >= 0) {
      const [f] = failures.splice(failure, 1);
      return new Response(f.body, { status: f.status });
    }

    // ['', 'api', 'v4', ...rest]
    if (segments[1] !== 'api' || segments[2] !== 'v4')
      return json(404, { message: '404 Not Found' });
    const rest = segments.slice(3);

    if (method === 'GET' && rest.length === 1 && rest[0] === 'users') {
      const search = (url.searchParams.get('search') ?? '').toLowerCase();
      return json(
        200,
        state.users.filter(
          u =>
            u.public_email?.toLowerCase() === search ||
            u.username.toLowerCase().includes(search),
        ),
      );
    }

    if (rest[0] !== 'projects') return json(404, { message: '404 Not Found' });
    if (rest[1] !== PROJECT_PATH && rest[1] !== String(PROJECT_ID))
      return json(404, { message: '404 Project Not Found' });
    const sub = rest.slice(2);

    if (method === 'GET' && sub.length === 0) {
      return json(200, {
        id: PROJECT_ID,
        path_with_namespace: PROJECT_PATH,
        default_branch: state.defaultBranch,
      });
    }

    if (method === 'GET' && sub.join('/') === 'repository/commits') {
      const perPage = Number(url.searchParams.get('per_page') ?? 20);
      const page = Number(url.searchParams.get('page') ?? 1);
      const slice = state.commits.slice((page - 1) * perPage, page * perPage);
      const hasNext = page * perPage < state.commits.length;
      return json(
        200,
        slice,
        state.nextPageHeader
          ? { 'x-next-page': hasNext ? String(page + 1) : '' }
          : {},
      );
    }

    if (sub[0] === 'repository' && sub[1] === 'files' && sub.length === 3) {
      const filePath = sub[2];
      if (method === 'GET') {
        const ref = url.searchParams.get('ref') ?? state.defaultBranch;
        const file = state.branches.get(ref)?.get(filePath);
        if (!file) return json(404, { message: '404 File Not Found' });
        return json(200, {
          file_path: filePath,
          encoding: 'base64',
          content: Buffer.from(file.content, 'utf8').toString('base64'),
          last_commit_id: file.commit,
          blob_id: `blob-${file.commit}`,
        });
      }
      const req = body as {
        branch: string;
        content: string;
        commit_message: string;
        last_commit_id?: string;
      };
      const files = state.branches.get(req.branch);
      if (!files)
        return json(400, {
          message: 'You can only create or edit files when you are on a branch',
        });
      const current = files.get(filePath);
      if (method === 'POST') {
        if (current)
          return json(400, {
            message: 'A file with this name already exists',
          });
      } else if (method === 'PUT') {
        if (!current)
          return json(400, { message: "A file with this name doesn't exist" });
        if (req.last_commit_id && req.last_commit_id !== current.commit) {
          return json(400, {
            message:
              'You are attempting to update a file that has changed since you started editing it.',
          });
        }
      } else {
        return json(405, { message: '405 Method Not Allowed' });
      }
      files.set(filePath, { content: req.content, commit: nextCommit() });
      return json(method === 'POST' ? 201 : 200, {
        file_path: filePath,
        branch: req.branch,
      });
    }

    if (method === 'POST' && sub.join('/') === 'repository/branches') {
      const { branch, ref } = body as { branch: string; ref: string };
      if (state.branches.has(branch))
        return json(400, { message: 'Branch already exists' });
      const start = state.branches.get(ref);
      if (!start) return json(400, { message: 'Invalid reference name' });
      state.branches.set(branch, new Map(start));
      return json(201, { name: branch });
    }

    if (sub[0] === 'merge_requests' && sub.length === 1) {
      if (method === 'GET') {
        const st = url.searchParams.get('state');
        const source = url.searchParams.get('source_branch');
        return json(
          200,
          state.mrs
            .filter(
              m =>
                (!st || m.state === st) &&
                (!source || m.sourceBranch === source),
            )
            .map(toJson),
        );
      }
      if (method === 'POST') {
        const req = body as {
          source_branch: string;
          target_branch: string;
          title: string;
          description: string;
          reviewer_ids?: number[];
        };
        const dup = state.mrs.find(
          m =>
            m.state === 'opened' &&
            m.sourceBranch === req.source_branch &&
            m.sourceProjectId === PROJECT_ID,
        );
        if (dup) {
          return json(409, {
            message: [
              `Another open merge request already exists for this source branch: !${dup.iid}`,
            ],
          });
        }
        const mr: MergeRequest = {
          iid: state.mrs.length + 1,
          sourceBranch: req.source_branch,
          targetBranch: req.target_branch,
          sourceProjectId: PROJECT_ID,
          title: req.title,
          description: req.description,
          // Like GitLab, unknown reviewer ids are silently dropped.
          reviewerIds: (req.reviewer_ids ?? []).filter(id =>
            state.users.some(u => u.id === id),
          ),
          state: 'opened',
          createdAt: '2026-10-01T00:00:00.000Z',
        };
        state.mrs.push(mr);
        return json(201, toJson(mr));
      }
    }

    if (sub[0] === 'merge_requests' && sub.length === 2) {
      const mr = state.mrs.find(m => String(m.iid) === sub[1]);
      if (!mr) return json(404, { message: '404 Not found' });
      if (method === 'GET') return json(200, toJson(mr));
      if (method === 'PUT') {
        const req = body as {
          title?: string;
          description?: string;
          reviewer_ids?: number[];
        };
        if (req.title !== undefined) mr.title = req.title;
        if (req.description !== undefined) mr.description = req.description;
        if (req.reviewer_ids !== undefined) mr.reviewerIds = req.reviewer_ids;
        return json(200, toJson(mr));
      }
    }

    if (method === 'GET' && sub.join('/') === 'approval_rules') {
      if (!state.approvalRulesAvailable)
        return json(403, { message: '403 Forbidden' });
      return json(200, state.approvalRules);
    }

    return json(404, { message: `no route ${route}` });
  };

  return {
    state,
    requests,
    reset,
    fetch: fetchImpl,
    /** Make the next request whose `METHOD /decoded/path` matches return `status` with a GitLab error body. */
    fail(match: RegExp, status: number, message: unknown = 'boom') {
      failures.push({ match, status, body: JSON.stringify({ message }) });
    },
    /** Change a file on `branch` behind the client's back. */
    touch(branch: string, path: string) {
      const file = state.branches.get(branch)!.get(path)!;
      file.content += '# changed\n';
      file.commit = nextCommit();
    },
    /** Add an MR from a fork whose source branch has the given name. */
    addForkMergeRequest(sourceBranch: string) {
      state.mrs.push({
        iid: state.mrs.length + 1,
        sourceBranch,
        targetBranch: state.defaultBranch,
        sourceProjectId: 999,
        title: 'From a fork',
        description: '',
        reviewerIds: [],
        state: 'opened',
        createdAt: '2026-10-01T00:00:00.000Z',
      });
    },
    /** Set an MR's state, e.g. after a merge. */
    setMergeRequestState(
      iid: number,
      next: MergeRequest['state'],
      at = '2026-10-02T00:00:00.000Z',
    ) {
      const mr = state.mrs.find(m => m.iid === iid)!;
      mr.state = next;
      if (next === 'merged') mr.mergedAt = at;
      if (next === 'closed') mr.closedAt = at;
    },
  };
}
