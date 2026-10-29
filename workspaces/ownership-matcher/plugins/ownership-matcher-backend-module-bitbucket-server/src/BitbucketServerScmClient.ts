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

import type { LoggerService } from '@backstage/backend-plugin-api';
import {
  getBitbucketServerRequestOptions,
  type BitbucketServerIntegrationConfig,
} from '@backstage/integration';
import {
  ScmError,
  type ScmClient,
  type ScmCommit,
  type ScmFile,
  type ScmFileLocation,
  type ScmHistoryCapability,
  type ScmPullRequest,
  type ScmPullRequestCapability,
  type ScmPullRequestRef,
  type ScmPullRequestState,
  type ScmRepoRef,
} from '@stepstone-tech/backstage-plugin-ownership-matcher-node';
import { toScmError } from './errors';
import {
  parseBitbucketServerLocation,
  splitRepoPath,
  trimTrailingSlashes,
} from './location';

const REQUEST_TIMEOUT_MS = 30_000;
const API_PATH = '/rest/api/1.0';

export interface BitbucketServerScmClientOptions {
  config: BitbucketServerIntegrationConfig;
  /**
   * Write-scoped token for the whole `pullRequests` flow (reads included).
   * Without it every `pullRequests` call throws `auth`: writes never fall
   * back to the integration's read credentials.
   */
  writeToken?: string;
  logger: LoggerService;
  /** Host-restricted fetch from `ScmProviderContext`. */
  fetch: typeof fetch;
}

interface Raw {
  status: number;
  ok: boolean;
  text: string;
}

interface BitbucketPullRequestJson {
  id: number;
  state?: string;
  /** Epoch millis. */
  createdDate?: number;
  /** Epoch millis; set once merged or declined. */
  closedDate?: number;
  links?: { self?: Array<{ href: string }> };
}

const PR_STATES: Record<string, ScmPullRequestState> = {
  OPEN: 'open',
  MERGED: 'merged',
  DECLINED: 'declined',
};

/**
 * Bitbucket Server (Data Center) implementation of the ownership-matcher SCM
 * contract: commit history via the integration's read
 * credentials, and branches, commits and pull requests only via the per-host
 * write token.
 *
 * Every request goes through the host-restricted `fetch` it is given. Failed
 * responses throw {@link ScmError}; normal outcomes (missing file, existing
 * branch, already-open PR) are returned.
 */
export class BitbucketServerScmClient implements ScmClient {
  readonly history: ScmHistoryCapability;
  readonly pullRequests: ScmPullRequestCapability;
  /** e.g. `https://repo.example.com` — `apiBaseUrl` without `/rest/api/1.0`. */
  private readonly root: string;
  private readonly readHeaders: Record<string, string>;
  /** `undefined` without a write token: the PR flow is refused. */
  private readonly writeHeaders: Record<string, string> | undefined;

  constructor(private readonly options: BitbucketServerScmClientOptions) {
    const { config, writeToken } = options;
    this.root = apiRoot(config);
    this.readHeaders = getBitbucketServerRequestOptions(config).headers;
    this.writeHeaders = writeToken
      ? { Authorization: `Bearer ${writeToken}` }
      : undefined;
    this.history = { getCommits: (repo, opts) => this.getCommits(repo, opts) };
    this.pullRequests = {
      getDefaultBranch: repo => this.getDefaultBranch(repo),
      readFile: (repo, path, branch) => this.readFile(repo, path, branch),
      createBranch: (repo, name, startPoint) =>
        this.createBranch(repo, name, startPoint),
      commitFile: (repo, path, opts) => this.commitFile(repo, path, opts),
      findOpenPullRequest: (repo, fromBranch) =>
        this.findOpenPullRequest(repo, fromBranch),
      getPullRequest: (repo, id) => this.getPullRequest(repo, id),
      createPullRequest: (repo, opts) => this.createPullRequest(repo, opts),
      updatePullRequest: (repo, pr, desired) =>
        this.updatePullRequest(repo, pr, desired),
      resolveReviewer: (_repo, email) => this.resolveReviewer(email),
      getDefaultReviewers: (repo, opts) => this.getDefaultReviewers(repo, opts),
    };
  }

  parseLocation(url: string): ScmFileLocation | undefined {
    return parseBitbucketServerLocation(url, this.options.config.host);
  }

  // ── history ────────────────────────────────────────────────────────────────

  private async getCommits(
    repo: ScmRepoRef,
    { limit }: { limit: number },
  ): Promise<ScmCommit[]> {
    const data = await this.json<{
      values?: Array<{
        id: string;
        author?: { emailAddress?: string; name?: string };
      }>;
    }>('getCommits', `${this.repoBase(repo)}/commits?limit=${limit}`, {
      headers: this.readHeaders,
    });
    return (data.values ?? []).slice(0, limit).map(c => ({
      id: c.id,
      author: {
        email: c.author?.emailAddress ?? '',
        name: c.author?.name ?? '',
      },
    }));
  }

  // ── pull requests ──────────────────────────────────────────────────────────

  private async getDefaultBranch(repo: ScmRepoRef): Promise<string> {
    const data = await this.json<{ displayId?: string }>(
      'getDefaultBranch',
      `${this.repoBase(repo)}/default-branch`,
    );
    if (!data.displayId)
      throw new ScmError('unknown', 'Default branch response has no displayId');
    return data.displayId;
  }

  /**
   * Content via `/raw`, revision = the commit that last modified the file
   * (from `/last-modified` on its directory), which Bitbucket checks as
   * `sourceCommitId` on update. Never falls back to the directory's latest
   * commit: a wrong-but-valid id would pass the conflict check and silently
   * overwrite a concurrent edit.
   */
  private async readFile(
    repo: ScmRepoRef,
    path: string,
    branch: string,
  ): Promise<ScmFile | undefined> {
    const base = this.repoBase(repo);
    const at = `at=refs/heads/${encodeURIComponent(branch)}`;
    const raw = await this.send(
      'readFile',
      `${base}/raw/${encodePath(path)}?${at}`,
    );
    if (raw.status === 404) return undefined;
    if (!raw.ok) throw toScmError(raw.status, raw.text);

    const slash = path.lastIndexOf('/');
    const dir = slash >= 0 ? path.slice(0, slash) : '';
    const fileName = slash >= 0 ? path.slice(slash + 1) : path;
    const lastModified = await this.json<{
      files?: Record<string, { id?: string } | undefined>;
    }>(
      'readFile:last-modified',
      `${base}/last-modified/${encodePath(dir)}?${at}`,
    );
    const revision = lastModified.files?.[fileName]?.id;
    if (!revision) {
      throw new ScmError(
        'unknown',
        `Could not resolve the last commit of ${path} on ${branch}`,
      );
    }
    return { content: raw.text, revision };
  }

  private async createBranch(
    repo: ScmRepoRef,
    name: string,
    startPoint: string,
  ): Promise<'created' | 'exists'> {
    const { projectKey, repoSlug } = this.split(repo);
    const res = await this.send(
      'createBranch',
      `${this.root}/rest/branch-utils/1.0/projects/${enc(
        projectKey,
      )}/repos/${enc(repoSlug)}/branches`,
      { method: 'POST', json: { name, startPoint } },
    );
    if (res.ok) return 'created';
    const err = toScmError(res.status, res.text);
    // A 409 is normally "branch exists" — unless the repo is archived/read-only.
    if (err.kind === 'conflict') return 'exists';
    throw err;
  }

  /** Single commit via the content API (multipart PUT). Bitbucket rejects a stale `sourceCommitId` with 409. */
  private async commitFile(
    repo: ScmRepoRef,
    path: string,
    opts: {
      content: string;
      message: string;
      branch: string;
      revision?: string;
    },
  ): Promise<void> {
    const form = new FormData();
    form.append('content', opts.content);
    form.append('message', opts.message);
    form.append('branch', opts.branch);
    if (opts.revision) form.append('sourceCommitId', opts.revision);
    // No Content-Type: fetch sets the multipart boundary for FormData.
    const res = await this.send(
      'commitFile',
      `${this.repoBase(repo)}/browse/${encodePath(path)}`,
      {
        method: 'PUT',
        body: form,
      },
    );
    if (!res.ok) throw toScmError(res.status, res.text);
  }

  private async findOpenPullRequest(
    repo: ScmRepoRef,
    fromBranch: string,
  ): Promise<ScmPullRequestRef | undefined> {
    const at = encodeURIComponent(`refs/heads/${fromBranch}`);
    const data = await this.json<{ values?: BitbucketPullRequestJson[] }>(
      'findOpenPullRequest',
      `${this.repoBase(
        repo,
      )}/pull-requests?state=OPEN&direction=OUTGOING&at=${at}&limit=1`,
    );
    const pr = data.values?.[0];
    return pr ? toPrRef(pr) : undefined;
  }

  private async getPullRequest(
    repo: ScmRepoRef,
    id: string,
  ): Promise<ScmPullRequest | undefined> {
    const res = await this.send(
      'getPullRequest',
      `${this.repoBase(repo)}/pull-requests/${enc(id)}`,
    );
    if (res.status === 404) return undefined;
    if (!res.ok) throw toScmError(res.status, res.text);
    const pr = parseJson<BitbucketPullRequestJson>(res.text);
    const state = PR_STATES[pr.state ?? ''];
    if (!state)
      throw new ScmError(
        'unknown',
        `Pull request ${id} has unknown state ${pr.state}`,
      );
    return {
      ...toPrRef(pr),
      state,
      ...(pr.createdDate ? { createdAt: new Date(pr.createdDate) } : {}),
      ...(pr.closedDate ? { closedAt: new Date(pr.closedDate) } : {}),
    };
  }

  /** A duplicate (409 — an open PR for the same refs exists) is returned as `reused`. */
  private async createPullRequest(
    repo: ScmRepoRef,
    opts: {
      title: string;
      description: string;
      fromBranch: string;
      toBranch: string;
      reviewers?: string[];
    },
  ): Promise<{ status: 'created' | 'reused'; pr: ScmPullRequestRef }> {
    const { projectKey, repoSlug } = this.split(repo);
    const repository = { slug: repoSlug, project: { key: projectKey } };
    const res = await this.send(
      'createPullRequest',
      `${this.repoBase(repo)}/pull-requests`,
      {
        method: 'POST',
        json: {
          title: opts.title,
          description: opts.description,
          fromRef: { id: `refs/heads/${opts.fromBranch}`, repository },
          toRef: { id: `refs/heads/${opts.toBranch}`, repository },
          reviewers: (opts.reviewers ?? []).map(name => ({ user: { name } })),
        },
      },
    );
    if (res.ok)
      return {
        status: 'created',
        pr: toPrRef(parseJson<BitbucketPullRequestJson>(res.text)),
      };
    const err = toScmError(res.status, res.text);
    // A duplicate-PR 409 is reused — unless the repo is archived/read-only.
    if (err.kind === 'conflict') {
      const existing = await this.findOpenPullRequest(repo, opts.fromBranch);
      if (existing) return { status: 'reused', pr: existing };
    }
    throw err;
  }

  /**
   * Fetches the PR first — for its `version` (optimistic locking) and its
   * current reviewers, which a PUT replaces — and only writes when something
   * differs. Existing reviewers are kept.
   */
  private async updatePullRequest(
    repo: ScmRepoRef,
    pr: ScmPullRequestRef,
    desired: { title: string; description: string; addReviewers?: string[] },
  ): Promise<'updated' | 'unchanged'> {
    const url = `${this.repoBase(repo)}/pull-requests/${enc(pr.id)}`;
    const current = await this.json<{
      version?: number;
      title?: string;
      description?: string;
      reviewers?: Array<{ user: { name?: string; slug?: string } }>;
    }>('updatePullRequest', url);
    if (typeof current.version !== 'number') {
      throw new ScmError(
        'unknown',
        `Pull request ${pr.id} response has no version`,
      );
    }

    const existing = (current.reviewers ?? [])
      .map(r => r.user.name || r.user.slug)
      .filter((n): n is string => Boolean(n));
    const known = new Set(existing.map(n => n.toLowerCase()));
    const added = (desired.addReviewers ?? []).filter(
      n => !known.has(n.toLowerCase()),
    );
    if (
      current.title === desired.title &&
      (current.description ?? '') === desired.description &&
      added.length === 0
    ) {
      return 'unchanged';
    }

    const res = await this.send('updatePullRequest', url, {
      method: 'PUT',
      json: {
        version: current.version,
        title: desired.title,
        description: desired.description,
        reviewers: [...existing, ...added].map(name => ({ user: { name } })),
      },
    });
    if (!res.ok) throw toScmError(res.status, res.text);
    return 'updated';
  }

  /**
   * Bitbucket user name with exactly this email (case-insensitive). The `name`,
   * not the lowercased `slug`: PR reviewers are looked up by `name`, which is
   * case-sensitive and may be mixed-case (`SmithA01`).
   */
  private async resolveReviewer(email: string): Promise<string | undefined> {
    const data = await this.json<{
      values?: Array<{ name?: string; slug: string; emailAddress?: string }>;
    }>(
      'resolveReviewer',
      `${this.root}${API_PATH}/users?filter=${encodeURIComponent(
        email,
      )}&limit=25`,
    );
    const lower = email.toLowerCase();
    const user = data.values?.find(
      u => u.emailAddress?.toLowerCase() === lower,
    );
    return user ? user.name || user.slug : undefined;
  }

  /**
   * The repository's effective default reviewers for a PR between the refs.
   * Bitbucket doesn't add them to REST-created PRs, so callers pass them
   * explicitly.
   */
  private async getDefaultReviewers(
    repo: ScmRepoRef,
    { fromBranch, toBranch }: { fromBranch: string; toBranch: string },
  ): Promise<string[]> {
    const { projectKey, repoSlug } = this.split(repo);
    const repoJson = await this.json<{ id?: number }>(
      'getDefaultReviewers',
      this.repoBase(repo),
    );
    if (repoJson.id === undefined)
      throw new ScmError('unknown', 'Repository response has no id');
    const params = new URLSearchParams({
      sourceRepoId: String(repoJson.id),
      targetRepoId: String(repoJson.id),
      sourceRefId: `refs/heads/${fromBranch}`,
      targetRefId: `refs/heads/${toBranch}`,
    });
    const users = await this.json<
      Array<{ name?: string; slug?: string; active?: boolean }>
    >(
      'getDefaultReviewers',
      `${this.root}/rest/default-reviewers/1.0/projects/${enc(
        projectKey,
      )}/repos/${enc(repoSlug)}/reviewers?${params}`,
    );
    if (!Array.isArray(users))
      throw new ScmError('unknown', 'Default reviewers response is not a list');
    // `name`, not `slug` (always lowercase): see resolveReviewer.
    return users
      .filter(u => (u.name || u.slug) && u.active !== false)
      .map(u => (u.name || u.slug)!);
  }

  // ── transport ──────────────────────────────────────────────────────────────

  private repoBase(repo: ScmRepoRef): string {
    const { projectKey, repoSlug } = this.split(repo);
    return `${this.root}${API_PATH}/projects/${enc(projectKey)}/repos/${enc(
      repoSlug,
    )}`;
  }

  private split(repo: ScmRepoRef): { projectKey: string; repoSlug: string } {
    const parts = splitRepoPath(repo);
    if (!parts)
      throw new ScmError(
        'invalid',
        `Not a Bitbucket Server repository path: ${repo.path}`,
      );
    return parts;
  }

  /** GET (or other) returning parsed JSON; any non-2xx throws. */
  private async json<T>(
    op: string,
    url: string,
    opts: { headers?: Record<string, string> } = {},
  ): Promise<T> {
    const res = await this.send(op, url, opts);
    if (!res.ok) throw toScmError(res.status, res.text);
    return parseJson<T>(res.text);
  }

  /**
   * One request with a timeout. Uses the write headers unless told otherwise
   * (the whole PR flow, reads included, runs on the write credential, so a
   * read never succeeds with a token that couldn't do the following write).
   * Without a write token such requests throw `auth` before any I/O.
   * Network failures throw `unavailable`.
   */
  private async send(
    op: string,
    url: string,
    opts: {
      method?: string;
      headers?: Record<string, string>;
      json?: unknown;
      body?: BodyInit;
    } = {},
  ): Promise<Raw> {
    const auth = opts.headers ?? this.writeHeaders;
    if (!auth) {
      throw new ScmError(
        'auth',
        `No write token configured for ${this.options.config.host} (ownershipMatcher.scm.hosts[].writeToken)`,
      );
    }
    const headers: Record<string, string> = {
      Accept: 'application/json',
      ...auth,
    };
    let body = opts.body;
    if (opts.json !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(opts.json);
    }
    try {
      const res = await this.options.fetch(url, {
        method: opts.method ?? 'GET',
        headers,
        body,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      return { status: res.status, ok: res.ok, text: await res.text() };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.options.logger.warn(`Bitbucket ${op} request failed: ${message}`);
      throw new ScmError('unavailable', message, { cause: err });
    }
  }
}

/** `https://host/rest/api/1.0` → `https://host`; any other API base → its origin. */
export function apiRoot(config: BitbucketServerIntegrationConfig): string {
  const base = trimTrailingSlashes(config.apiBaseUrl);
  if (base.endsWith(API_PATH)) return base.slice(0, -API_PATH.length);
  try {
    return new URL(base).origin;
  } catch {
    return `https://${config.host}`;
  }
}

function toPrRef(pr: BitbucketPullRequestJson): ScmPullRequestRef {
  return { id: String(pr.id), url: pr.links?.self?.[0]?.href ?? '' };
}

function parseJson<T>(text: string): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ScmError(
      'unknown',
      `Unparseable Bitbucket response: ${text.slice(0, 200)}`,
    );
  }
}

function enc(segment: string): string {
  return encodeURIComponent(segment);
}

/** URL-encode each path segment, keeping `/` separators. */
function encodePath(path: string): string {
  return path.split('/').filter(Boolean).map(encodeURIComponent).join('/');
}
