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
import { ScmError } from '../scm/ScmError';
import type { ScmClient, ScmProvider, ScmRepoRef } from '../scm/types';
import { describeScmProviderConformance } from './describeScmProviderConformance';

// A tiny in-memory SCM ("scm.example.com") with a JSON API, plus a provider
// for it. Exercises the conformance kit end-to-end the way a real provider
// module would use it.

const HOST = 'scm.example.com';
const API = `https://${HOST}/api`;

interface FakeState {
  branches: Map<string, Map<string, { content: string; revision: number }>>;
  pulls: Array<{ id: number; from: string; to: string }>;
  revision: number;
}

function initialState(): FakeState {
  return {
    branches: new Map([
      [
        'main',
        new Map([
          ['catalog-info.yaml', { content: 'kind: Component\n', revision: 1 }],
        ]),
      ],
    ]),
    pulls: [],
    revision: 1,
  };
}

let state = initialState();

const json = (status: number, body?: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), { status });

const fakeFetch: typeof fetch = async (input, init) => {
  const url = new URL(
    typeof input === 'string' || input instanceof URL
      ? input.toString()
      : input.url,
  );
  const method = init?.method ?? 'GET';
  const body = init?.body ? JSON.parse(String(init.body)) : undefined;
  const m = /^\/api\/repos\/acme\/widgets\/(.*)$/.exec(url.pathname);
  if (!m) return json(404);
  const [resource, ...rest] = m[1].split('/');
  const file = rest.join('/');

  switch (`${method} ${resource}`) {
    case 'GET default-branch':
      return json(200, { branch: 'main' });
    case 'GET commits':
      return json(200, [{ id: 'c1', email: 'a@example.com', name: 'A' }]);
    case 'GET files': {
      const f = state.branches.get(url.searchParams.get('ref')!)?.get(file);
      return f ? json(200, f) : json(404);
    }
    case 'PUT files': {
      const files = state.branches.get(body.branch);
      const current = files?.get(file);
      if (!files || !current) return json(404);
      if (current.revision !== body.revision) return json(409);
      files.set(file, { content: body.content, revision: ++state.revision });
      return json(200);
    }
    case 'POST branches': {
      if (state.branches.has(body.name)) return json(409);
      state.branches.set(body.name, new Map(state.branches.get(body.start)));
      return json(201);
    }
    case 'GET pulls': {
      if (file) {
        const pr = state.pulls.find(p => String(p.id) === file);
        return pr ? json(200, pr) : json(404);
      }
      return json(
        200,
        state.pulls.filter(p => p.from === url.searchParams.get('from')),
      );
    }
    case 'POST pulls': {
      if (state.pulls.some(p => p.from === body.from)) return json(409);
      const pr = { id: state.pulls.length + 1, from: body.from, to: body.to };
      state.pulls.push(pr);
      return json(201, pr);
    }
    default:
      return json(404);
  }
};

const fakeProvider: ScmProvider = {
  type: 'gitlab',
  createClient(ctx): ScmClient {
    const call = async (path: string, init?: RequestInit) => {
      const res = await ctx.fetch(`${API}/repos/acme/widgets/${path}`, init);
      const text = await res.text();
      return { status: res.status, body: text ? JSON.parse(text) : undefined };
    };
    const send = (method: string, body: unknown): RequestInit => ({
      method,
      body: JSON.stringify(body),
    });
    const toPr = (p: { id: number }) => ({
      id: String(p.id),
      url: `https://${HOST}/acme/widgets/-/merge_requests/${p.id}`,
    });
    const fail = (status: number) => {
      throw new ScmError(
        status === 409 ? 'conflict' : 'unknown',
        `HTTP ${status}`,
        { httpStatus: status },
      );
    };
    const find = async (_repo: ScmRepoRef, from: string) => {
      const { body } = await call(`pulls?from=${encodeURIComponent(from)}`);
      return body[0] ? toPr(body[0]) : undefined;
    };

    return {
      parseLocation(url) {
        const m =
          /^https:\/\/scm\.example\.com\/(.+)\/-\/blob\/([^/]+)\/(.+)$/.exec(
            url,
          );
        if (!m) return undefined;
        return {
          repo: {
            type: 'gitlab',
            host: HOST,
            path: m[1],
            webUrl: `https://${HOST}/${m[1]}`,
          },
          path: m[3],
          ref: m[2],
        };
      },
      history: {
        async getCommits(_repo, { limit }) {
          const { body } = await call('commits');
          return body.slice(0, limit).map((c: any) => ({
            id: c.id,
            author: { email: c.email, name: c.name },
          }));
        },
      },
      pullRequests: {
        async getDefaultBranch() {
          return (await call('default-branch')).body.branch;
        },
        async readFile(_repo, path, branch) {
          const { status, body } = await call(`files/${path}?ref=${branch}`);
          if (status === 404) return undefined;
          return { content: body.content, revision: String(body.revision) };
        },
        async createBranch(_repo, name, start) {
          const { status } = await call(
            'branches',
            send('POST', { name, start }),
          );
          if (status === 409) return 'exists';
          return status === 201 ? 'created' : fail(status);
        },
        async commitFile(_repo, path, opts) {
          const { status } = await call(
            `files/${path}`,
            send('PUT', { ...opts, revision: Number(opts.revision) }),
          );
          if (status !== 200) fail(status);
        },
        findOpenPullRequest: find,
        async getPullRequest(_repo, id) {
          const { status, body } = await call(
            `pulls/${encodeURIComponent(id)}`,
          );
          if (status === 404) return undefined;
          return { ...toPr(body), state: 'open' };
        },
        async createPullRequest(repo, opts) {
          const { status, body } = await call(
            'pulls',
            send('POST', { from: opts.fromBranch, to: opts.toBranch }),
          );
          if (status === 201) return { status: 'created', pr: toPr(body) };
          const existing =
            status === 409 ? await find(repo, opts.fromBranch) : undefined;
          return existing ? { status: 'reused', pr: existing } : fail(status);
        },
        async updatePullRequest() {
          return 'unchanged';
        },
        async resolveReviewer() {
          return undefined;
        },
        async getDefaultReviewers() {
          return [];
        },
      },
    };
  },
};

const integration = ScmIntegrations.fromConfig(
  new ConfigReader({
    integrations: { gitlab: [{ host: HOST, apiBaseUrl: API, token: 't' }] },
  }),
).byHost(HOST)!;

describeScmProviderConformance(fakeProvider, {
  fakeServer: {
    integration,
    fetch: fakeFetch,
    reset: () => {
      state = initialState();
    },
    location: {
      url: `https://${HOST}/acme/widgets/-/blob/main/catalog-info.yaml`,
      expected: {
        repo: {
          type: 'gitlab',
          host: HOST,
          path: 'acme/widgets',
          webUrl: `https://${HOST}/acme/widgets`,
        },
        path: 'catalog-info.yaml',
        ref: 'main',
      },
    },
    unparseableUrl: `https://${HOST}/acme/widgets`,
    baseBranch: 'main',
    async makeRevisionStale(location, branch) {
      const file = state.branches.get(branch)!.get(location.path)!;
      file.revision = ++state.revision;
    },
  },
});
