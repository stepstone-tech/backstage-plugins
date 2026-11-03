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

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  ScmError,
  type ScmFile,
  type ScmPullRequest,
  type ScmPullRequestCapability,
  type ScmPullRequestRef,
  type ScmRepoRef,
} from '@stepstone-tech/backstage-plugin-ownership-matcher-node';
import { repoFilePath } from '../devScmServer';
import { repoSlugOf } from './MockScmProvider';

/** The only branch that exists on disk. Everything else lives in memory. */
const DEFAULT_BRANCH = 'main';

/** @see MockPrStore */
export interface MockPrStoreOptions {
  /** The dev SCM server's writable copy. Merges land here. */
  rootDir: string;
  /** How long a pull request stays open before it merges itself. */
  mergeAfterMs: number;
  /** Injectable clock, so the merge delay can be stepped through in tests. */
  now?: () => number;
}

interface MockedPullRequest extends ScmPullRequestRef {
  repo: ScmRepoRef;
  fromBranch: string;
  toBranch: string;
  title: string;
  description: string;
  reviewers: string[];
  createdAt: Date;
  state: 'open' | 'merged';
  closedAt?: Date;
}

/**
 * Pull requests that live in memory and merge themselves after a delay.
 *
 * The point of the delay is that the merge is not simulated: when it fires,
 * the branch's content is written over the file in the served copy of
 * `examples/`, the catalog re-reads it, and the case closes as
 * `ownership_changed` for the same reason it would against a real SCM.
 */
export class MockPrStore implements ScmPullRequestCapability {
  /** `<repo path>#<branch>` → path → content. The default branch is not in here; it is on disk. */
  private readonly branches = new Map<string, Map<string, string>>();
  private readonly pullRequests = new Map<string, MockedPullRequest>();
  private readonly now: () => number;
  private nextId = 1;

  constructor(private readonly options: MockPrStoreOptions) {
    this.now = options.now ?? Date.now;
  }

  async getDefaultBranch(_repo: ScmRepoRef): Promise<string> {
    return DEFAULT_BRANCH;
  }

  async readFile(
    repo: ScmRepoRef,
    path: string,
    branch: string,
  ): Promise<ScmFile | undefined> {
    const onBranch = this.branches.get(branchKey(repo, branch))?.get(path);
    if (onBranch !== undefined) return toFile(onBranch);

    const content = await readFile(this.fileOf(repo, path), 'utf8').catch(
      () => undefined,
    );
    return content === undefined ? undefined : toFile(content);
  }

  async createBranch(
    repo: ScmRepoRef,
    name: string,
    _startPoint: string,
  ): Promise<'created' | 'exists'> {
    const key = branchKey(repo, name);
    if (this.branches.has(key)) return 'exists';
    // Empty: a file not committed on the branch still reads through to disk,
    // which is what branching off the default branch means here.
    this.branches.set(key, new Map());
    return 'created';
  }

  async commitFile(
    repo: ScmRepoRef,
    path: string,
    opts: {
      content: string;
      message: string;
      branch: string;
      revision?: string;
    },
  ): Promise<void> {
    // Checked before anything else: `path` reaches this from a parsed URL, and
    // a merge later writes it straight into the served directory.
    this.fileOf(repo, path);

    const current = await this.readFile(repo, path, opts.branch);
    if (opts.revision === undefined) {
      if (current) {
        throw new ScmError(
          'conflict',
          `${path} already exists on ${opts.branch}; pass a revision to update it`,
        );
      }
    } else if (!current) {
      throw new ScmError(
        'conflict',
        `${path} does not exist on ${opts.branch}`,
      );
    } else if (current.revision !== opts.revision) {
      throw new ScmError(
        'conflict',
        `${path} on ${opts.branch} moved on since revision ${opts.revision}`,
      );
    }

    const key = branchKey(repo, opts.branch);
    const branch = this.branches.get(key) ?? new Map<string, string>();
    branch.set(path, opts.content);
    this.branches.set(key, branch);
  }

  async findOpenPullRequest(
    repo: ScmRepoRef,
    fromBranch: string,
  ): Promise<ScmPullRequestRef | undefined> {
    for (const pr of this.pullRequests.values()) {
      if (pr.repo.path !== repo.path || pr.fromBranch !== fromBranch) continue;
      const settled = await this.settle(pr);
      if (settled.state === 'open') return { id: pr.id, url: pr.url };
    }
    return undefined;
  }

  async getPullRequest(
    _repo: ScmRepoRef,
    id: string,
  ): Promise<ScmPullRequest | undefined> {
    const pr = this.pullRequests.get(id);
    if (!pr) return undefined;
    const settled = await this.settle(pr);
    return {
      id: settled.id,
      url: settled.url,
      state: settled.state,
      createdAt: settled.createdAt,
      ...(settled.closedAt ? { closedAt: settled.closedAt } : {}),
    };
  }

  async createPullRequest(
    repo: ScmRepoRef,
    opts: {
      title: string;
      description: string;
      fromBranch: string;
      toBranch: string;
      reviewers?: string[];
    },
  ): Promise<{ status: 'created' | 'reused'; pr: ScmPullRequestRef }> {
    const existing = await this.findOpenPullRequest(repo, opts.fromBranch);
    if (existing) return { status: 'reused', pr: existing };

    const id = String(this.nextId++);
    const pr: MockedPullRequest = {
      id,
      url: `${repo.webUrl.replace(/\/browse$/, '')}/pull-requests/${id}`,
      repo,
      fromBranch: opts.fromBranch,
      toBranch: opts.toBranch,
      title: opts.title,
      description: opts.description,
      reviewers: [...(opts.reviewers ?? [])],
      createdAt: new Date(this.now()),
      state: 'open',
    };
    this.pullRequests.set(id, pr);
    return { status: 'created', pr: { id: pr.id, url: pr.url } };
  }

  async updatePullRequest(
    _repo: ScmRepoRef,
    ref: ScmPullRequestRef,
    desired: { title: string; description: string; addReviewers?: string[] },
  ): Promise<'updated' | 'unchanged'> {
    const pr = this.pullRequests.get(ref.id);
    if (!pr) throw new ScmError('not-found', `No pull request ${ref.id}`);

    const added = (desired.addReviewers ?? []).filter(
      r => !pr.reviewers.includes(r),
    );
    if (
      pr.title === desired.title &&
      pr.description === desired.description &&
      added.length === 0
    ) {
      return 'unchanged';
    }
    pr.title = desired.title;
    pr.description = desired.description;
    pr.reviewers.push(...added);
    return 'updated';
  }

  /** No user directory here: the e-mail address is the reviewer id. */
  async resolveReviewer(
    _repo: ScmRepoRef,
    email: string,
  ): Promise<string | undefined> {
    return email;
  }

  async getDefaultReviewers(
    _repo: ScmRepoRef,
    _opts: { fromBranch: string; toBranch: string },
  ): Promise<string[]> {
    return [];
  }

  /** Absolute path of `path` in `repo`, or an `invalid` ScmError if it escapes the served copy. */
  private fileOf(repo: ScmRepoRef, path: string): string {
    const slug = repoSlugOf(repo.path);
    const file = slug
      ? repoFilePath(this.options.rootDir, slug, path)
      : undefined;
    if (!file) {
      throw new ScmError(
        'invalid',
        `${repo.path}/${path} is not a dev catalog file`,
      );
    }
    return file;
  }

  /**
   * Merge the pull request if its delay has elapsed. Called on every read,
   * so the state advances exactly when something asks for it — which is what
   * `PrReconciliationService` does on its loop.
   */
  private async settle(pr: MockedPullRequest): Promise<MockedPullRequest> {
    if (pr.state !== 'open') return pr;
    if (this.now() - pr.createdAt.getTime() < this.options.mergeAfterMs) {
      return pr;
    }

    const branch = this.branches.get(branchKey(pr.repo, pr.fromBranch));
    for (const [path, content] of branch ?? []) {
      const file = this.fileOf(pr.repo, path);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, content, 'utf8');
    }
    pr.state = 'merged';
    pr.closedAt = new Date(this.now());
    return pr;
  }
}

function branchKey(repo: ScmRepoRef, branch: string): string {
  return `${repo.path}#${branch}`;
}

function toFile(content: string): ScmFile {
  return {
    content,
    revision: createHash('sha256').update(content).digest('hex').slice(0, 12),
  };
}
