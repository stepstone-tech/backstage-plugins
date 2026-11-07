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
  getGitLabRequestOptions,
  type GitLabIntegrationConfig,
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
import { parseGitLabLocation, trimTrailingSlashes } from './location';

const REQUEST_TIMEOUT_MS = 30_000;
/** GitLab's maximum `per_page`. */
const MAX_PER_PAGE = 100;

export interface GitLabScmClientOptions {
  config: GitLabIntegrationConfig;
  /**
   * Token for the whole merge-request flow (reads included). Never falls back
   * to the integration's read credentials: without it, every `pullRequests`
   * call throws `auth`.
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
  headers: Headers;
}

interface GitLabUserJson {
  id: number;
  username?: string;
  name?: string;
  state?: string;
  email?: string;
  public_email?: string;
}

interface GitLabMergeRequestJson {
  iid: number;
  web_url?: string;
  state?: string;
  title?: string;
  description?: string | null;
  source_project_id?: number;
  target_project_id?: number;
  created_at?: string;
  merged_at?: string | null;
  closed_at?: string | null;
  reviewers?: GitLabUserJson[];
}

interface GitLabApprovalRuleJson {
  rule_type?: string;
  eligible_approvers?: GitLabUserJson[];
  users?: GitLabUserJson[];
  protected_branches?: Array<{ name?: string }>;
  applies_to_all_protected_branches?: boolean;
}

/** `locked` is a transient state while GitLab merges the MR. */
const MR_STATES: Record<string, ScmPullRequestState> = {
  opened: 'open',
  locked: 'open',
  merged: 'merged',
  closed: 'declined',
};

/** Approval rule types that don't name required approvers. */
const NON_REVIEWER_RULE_TYPES = new Set([
  'any_approver',
  'report_approver',
  'code_owner',
]);

/**
 * GitLab (gitlab.com or self-managed) implementation of the ownership-matcher
 * SCM contract: commit history via the integration's credentials, and
 * branches, commits and merge requests via the per-host write token, falling
 * back to the integration token.
 *
 * Every request goes through the host-restricted `fetch` it is given. Failed
 * responses throw {@link ScmError}; normal outcomes (missing file, existing
 * branch, already-open MR) are returned.
 */
export class GitLabScmClient implements ScmClient {
  readonly history: ScmHistoryCapability;
  readonly pullRequests: ScmPullRequestCapability;
  /** e.g. `https://gitlab.com/api/v4`. */
  private readonly apiBase: string;
  private readonly readHeaders: Record<string, string>;
  /** `undefined` without a write token: the merge-request flow is refused. */
  private readonly writeHeaders: Record<string, string> | undefined;

  constructor(private readonly options: GitLabScmClientOptions) {
    const { config, writeToken } = options;
    this.apiBase = trimTrailingSlashes(config.apiBaseUrl);
    this.readHeaders = getGitLabRequestOptions(config).headers;
    this.writeHeaders = writeToken
      ? getGitLabRequestOptions(config, writeToken).headers
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
    return parseGitLabLocation(url, this.options.config);
  }

  // ── history ────────────────────────────────────────────────────────────────

  /**
   * Newest-first commits on the default branch. `per_page` follows `limit`
   * (GitLab's default is 20), capped at 100; larger limits page through.
   */
  private async getCommits(
    repo: ScmRepoRef,
    { limit }: { limit: number },
  ): Promise<ScmCommit[]> {
    const perPage = Math.max(1, Math.min(limit, MAX_PER_PAGE));
    const commits: ScmCommit[] = [];
    let page = 1;
    while (commits.length < limit) {
      const res = await this.send(
        'getCommits',
        `${this.projectBase(
          repo,
        )}/repository/commits?per_page=${perPage}&page=${page}`,
        { headers: this.readHeaders },
      );
      if (!res.ok) throw toScmError(res.status, res.text);
      const values = parseJson<
        Array<{ id: string; author_email?: string; author_name?: string }>
      >(res.text);
      if (!Array.isArray(values))
        throw new ScmError('unknown', 'Commits response is not a list');
      for (const c of values) {
        commits.push({
          id: c.id,
          author: { email: c.author_email ?? '', name: c.author_name ?? '' },
        });
      }
      const next = res.headers.get('x-next-page');
      if (next !== null) {
        if (!next) break;
        page = Number(next);
        if (!Number.isFinite(page)) break;
      } else {
        if (values.length < perPage) break;
        page++;
      }
    }
    return commits.slice(0, limit);
  }

  // ── merge requests ─────────────────────────────────────────────────────────

  private async getDefaultBranch(repo: ScmRepoRef): Promise<string> {
    const data = await this.json<{ default_branch?: string }>(
      'getDefaultBranch',
      this.projectBase(repo),
    );
    if (!data.default_branch)
      throw new ScmError('unknown', 'Project response has no default_branch');
    return data.default_branch;
  }

  /**
   * Content via the Files API; revision = `last_commit_id` (the commit that
   * last modified the file), which GitLab checks on update.
   */
  private async readFile(
    repo: ScmRepoRef,
    path: string,
    branch: string,
  ): Promise<ScmFile | undefined> {
    const res = await this.send(
      'readFile',
      `${this.fileUrl(repo, path)}?ref=${encodeURIComponent(branch)}`,
    );
    if (res.status === 404) return undefined;
    if (!res.ok) throw toScmError(res.status, res.text);
    const file = parseJson<{
      content?: string;
      encoding?: string;
      last_commit_id?: string;
    }>(res.text);
    if (typeof file.content !== 'string' || !file.last_commit_id) {
      throw new ScmError(
        'unknown',
        `File response for ${path} on ${branch} has no content or last_commit_id`,
      );
    }
    const content =
      file.encoding === 'base64'
        ? Buffer.from(file.content, 'base64').toString('utf8')
        : file.content;
    return { content, revision: file.last_commit_id };
  }

  private async createBranch(
    repo: ScmRepoRef,
    name: string,
    startPoint: string,
  ): Promise<'created' | 'exists'> {
    const res = await this.send(
      'createBranch',
      `${this.projectBase(repo)}/repository/branches`,
      { method: 'POST', json: { branch: name, ref: startPoint } },
    );
    if (res.ok) return 'created';
    const err = toScmError(res.status, res.text);
    // "Branch already exists" — unless the project is archived/read-only.
    if (err.kind === 'conflict') return 'exists';
    throw err;
  }

  /**
   * One commit via the Files API: update (PUT, guarded by `last_commit_id`)
   * with a revision, create (POST) without. A stale revision, or creating a
   * file that exists, is a `conflict`.
   */
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
    const res = await this.send('commitFile', this.fileUrl(repo, path), {
      method: opts.revision ? 'PUT' : 'POST',
      json: {
        branch: opts.branch,
        content: opts.content,
        commit_message: opts.message,
        ...(opts.revision ? { last_commit_id: opts.revision } : {}),
      },
    });
    if (!res.ok) throw toScmError(res.status, res.text);
  }

  /** The open MR from `fromBranch` of this project (not a fork's same-named branch). */
  private async findOpenPullRequest(
    repo: ScmRepoRef,
    fromBranch: string,
  ): Promise<ScmPullRequestRef | undefined> {
    const params = new URLSearchParams({
      state: 'opened',
      source_branch: fromBranch,
      per_page: '20',
    });
    const mrs = await this.json<GitLabMergeRequestJson[]>(
      'findOpenPullRequest',
      `${this.projectBase(repo)}/merge_requests?${params}`,
    );
    if (!Array.isArray(mrs))
      throw new ScmError('unknown', 'Merge requests response is not a list');
    const mr = mrs.find(
      m =>
        m.source_project_id === undefined ||
        m.source_project_id === m.target_project_id,
    );
    return mr ? toPrRef(mr) : undefined;
  }

  private async getPullRequest(
    repo: ScmRepoRef,
    id: string,
  ): Promise<ScmPullRequest | undefined> {
    const res = await this.send(
      'getPullRequest',
      `${this.projectBase(repo)}/merge_requests/${encodeURIComponent(id)}`,
    );
    if (res.status === 404) return undefined;
    if (!res.ok) throw toScmError(res.status, res.text);
    const mr = parseJson<GitLabMergeRequestJson>(res.text);
    const state = MR_STATES[mr.state ?? ''];
    if (!state)
      throw new ScmError(
        'unknown',
        `Merge request ${id} has unknown state ${mr.state}`,
      );
    const closed = mr.merged_at ?? mr.closed_at;
    return {
      ...toPrRef(mr),
      state,
      ...(mr.created_at ? { createdAt: new Date(mr.created_at) } : {}),
      ...(state !== 'open' && closed ? { closedAt: new Date(closed) } : {}),
    };
  }

  /** A duplicate (409 — an open MR for the source branch exists) is returned as `reused`. */
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
    const res = await this.send(
      'createPullRequest',
      `${this.projectBase(repo)}/merge_requests`,
      {
        method: 'POST',
        json: {
          source_branch: opts.fromBranch,
          target_branch: opts.toBranch,
          title: opts.title,
          description: opts.description,
          reviewer_ids: toUserIds(opts.reviewers ?? []),
        },
      },
    );
    if (res.ok)
      return {
        status: 'created',
        pr: toPrRef(parseJson<GitLabMergeRequestJson>(res.text)),
      };
    const err = toScmError(res.status, res.text);
    // A duplicate-MR 409 is reused — unless the project is archived/read-only.
    if (err.kind === 'conflict') {
      const existing = await this.findOpenPullRequest(repo, opts.fromBranch);
      if (existing) return { status: 'reused', pr: existing };
    }
    throw err;
  }

  /**
   * Fetches the MR first — for its current reviewers, which `reviewer_ids`
   * replaces — and only writes when something differs. Existing reviewers are
   * kept.
   */
  private async updatePullRequest(
    repo: ScmRepoRef,
    pr: ScmPullRequestRef,
    desired: { title: string; description: string; addReviewers?: string[] },
  ): Promise<'updated' | 'unchanged'> {
    const url = `${this.projectBase(repo)}/merge_requests/${encodeURIComponent(
      pr.id,
    )}`;
    const current = await this.json<GitLabMergeRequestJson>(
      'updatePullRequest',
      url,
    );
    const existing = (current.reviewers ?? []).map(r => r.id);
    const known = new Set(existing);
    const added = toUserIds(desired.addReviewers ?? []).filter(
      id => !known.has(id),
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
        title: desired.title,
        description: desired.description,
        ...(added.length ? { reviewer_ids: [...existing, ...added] } : {}),
      },
    });
    if (!res.ok) throw toScmError(res.status, res.text);
    return 'updated';
  }

  /**
   * The id of the active GitLab user with this email. Users whose returned
   * `email`/`public_email` matches (case-insensitively) win; otherwise a single
   * active search hit is taken. On gitlab.com a non-admin token only finds
   * users by their *public* email, and the list response carries no email.
   * `search` also matches name and username, so a single hit whose name or
   * username contains the email is rejected: the match must come from the
   * email.
   */
  private async resolveReviewer(email: string): Promise<string | undefined> {
    const params = new URLSearchParams({ search: email, per_page: '20' });
    const users = await this.json<GitLabUserJson[]>(
      'resolveReviewer',
      `${this.apiBase}/users?${params}`,
    );
    if (!Array.isArray(users)) return undefined;
    const active = users.filter(u => isActive(u) && typeof u.id === 'number');
    const lower = email.toLowerCase();
    const exact = active.find(
      u =>
        u.email?.toLowerCase() === lower ||
        u.public_email?.toLowerCase() === lower,
    );
    if (exact) return String(exact.id);
    if (active.length !== 1) return undefined;
    const [only] = active;
    const matchedByName = [only.name, only.username].some(v =>
      v?.toLowerCase().includes(lower),
    );
    return matchedByName ? undefined : String(only.id);
  }

  /**
   * Users named by the project's approval rules that apply to `toBranch`.
   * GitLab enforces those rules on every MR itself; requesting the approvers
   * as reviewers notifies them. Approval rules are a paid feature: a 403/404
   * (Free tier) means no default reviewers.
   */
  private async getDefaultReviewers(
    repo: ScmRepoRef,
    { toBranch }: { fromBranch: string; toBranch: string },
  ): Promise<string[]> {
    const res = await this.send(
      'getDefaultReviewers',
      `${this.projectBase(repo)}/approval_rules?per_page=${MAX_PER_PAGE}`,
    );
    if (res.status === 403 || res.status === 404) return [];
    if (!res.ok) throw toScmError(res.status, res.text);
    const rules = parseJson<GitLabApprovalRuleJson[]>(res.text);
    if (!Array.isArray(rules))
      throw new ScmError('unknown', 'Approval rules response is not a list');

    const ids = new Set<string>();
    for (const rule of rules) {
      if (NON_REVIEWER_RULE_TYPES.has(rule.rule_type ?? '')) continue;
      if (!ruleAppliesTo(rule, toBranch)) continue;
      for (const user of rule.eligible_approvers ?? rule.users ?? []) {
        if (typeof user.id === 'number' && isActive(user))
          ids.add(String(user.id));
      }
    }
    return [...ids];
  }

  // ── transport ──────────────────────────────────────────────────────────────

  private projectBase(repo: ScmRepoRef): string {
    if (!repo.path || repo.path.split('/').some(s => !s)) {
      throw new ScmError('invalid', `Not a GitLab project path: ${repo.path}`);
    }
    return `${this.apiBase}/projects/${encodeURIComponent(repo.path)}`;
  }

  /** The Files API takes the whole path as one encoded segment (`/` → `%2F`). */
  private fileUrl(repo: ScmRepoRef, path: string): string {
    const clean = path.split('/').filter(Boolean).join('/');
    return `${this.projectBase(repo)}/repository/files/${encodeURIComponent(
      clean,
    )}`;
  }

  /** GET returning parsed JSON; any non-2xx throws. */
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
   * (the whole MR flow, reads included, runs on the write credential, so a
   * read never succeeds with a token that couldn't do the following write).
   * Without any token such requests throw `auth` before any I/O.
   * Network failures throw `unavailable`.
   */
  private async send(
    op: string,
    url: string,
    opts: {
      method?: string;
      headers?: Record<string, string>;
      json?: unknown;
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
    let body: string | undefined;
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
      return {
        status: res.status,
        ok: res.ok,
        text: await res.text(),
        headers: res.headers,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.options.logger.warn(`GitLab ${op} request failed: ${message}`);
      throw new ScmError('unavailable', message, { cause: err });
    }
  }
}

function toPrRef(mr: GitLabMergeRequestJson): ScmPullRequestRef {
  return { id: String(mr.iid), url: mr.web_url ?? '' };
}

function isActive(user: GitLabUserJson): boolean {
  return user.state === undefined || user.state === 'active';
}

/**
 * Reviewer ids are GitLab user ids as strings. Anything else can't be a
 * reviewer: reject it as `invalid` (naming it) so core retries without it.
 */
function toUserIds(reviewers: string[]): number[] {
  const rejected = reviewers.filter(r => !/^\d+$/.test(r));
  if (rejected.length) {
    throw new ScmError(
      'invalid',
      `Not GitLab user ids: ${rejected.join(', ')}`,
      { rejectedReviewers: rejected },
    );
  }
  return [...new Set(reviewers.map(Number))];
}

/**
 * Whether an approval rule covers `branch`: rules without protected branches
 * (or for all protected branches) apply to every target; otherwise one of the
 * protected-branch names, which may contain `*` wildcards, must match.
 */
function ruleAppliesTo(rule: GitLabApprovalRuleJson, branch: string): boolean {
  const names = (rule.protected_branches ?? [])
    .map(b => b.name)
    .filter((n): n is string => Boolean(n));
  if (rule.applies_to_all_protected_branches || names.length === 0) return true;
  return names.some(name => wildcardMatch(name, branch));
}

function wildcardMatch(pattern: string, value: string): boolean {
  const parts = pattern.split('*');
  if (parts.length === 1) return pattern === value;
  if (!value.startsWith(parts[0])) return false;
  let pos = parts[0].length;
  for (let i = 1; i < parts.length - 1; i++) {
    const idx = value.indexOf(parts[i], pos);
    if (idx < 0) return false;
    pos = idx + parts[i].length;
  }
  const last = parts[parts.length - 1];
  return value.length - last.length >= pos && value.endsWith(last);
}

function parseJson<T>(text: string): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ScmError(
      'unknown',
      `Unparseable GitLab response: ${text.slice(0, 200)}`,
    );
  }
}
