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
import type { ScmIntegration } from '@backstage/integration';

// ─── Neutral value types ─────────────────────────────────────────────────────

/**
 * SCM-neutral identity of a repository.
 *
 * @public
 */
export interface ScmRepoRef {
  /** Provider type, equal to `ScmIntegration.type` (e.g. `bitbucketServer`, `gitlab`). */
  type: string;
  /** Integration host, e.g. `repo.example.com` or `gitlab.com`. */
  host: string;
  /** Provider-native repository path, e.g. `PROJ/repo` or `group/sub/project`. */
  path: string;
  /** Browser URL of the repository. */
  webUrl: string;
}

/**
 * A file inside a repository, as parsed from a `backstage.io/managed-by-location` URL.
 *
 * @public
 */
export interface ScmFileLocation {
  repo: ScmRepoRef;
  /** Decoded repo-relative path, e.g. `src/My Service/catalog-info.yaml`. */
  path: string;
  /** Branch the location pins, if any. Absent = the repository's default branch. */
  ref?: string;
}

/** @public */
export interface ScmCommit {
  id: string;
  author: { email: string; name: string };
}

/**
 * File content plus the provider-native revision token needed to update it
 * safely (Bitbucket: the last-modifying commit id; GitLab: the blob/commit id).
 *
 * @public
 */
export interface ScmFile {
  content: string;
  revision: string;
}

/** @public */
export interface ScmPullRequestRef {
  /** Provider-native, opaque PR identifier. */
  id: string;
  url: string;
}

/** @public */
export type ScmPullRequestState = 'open' | 'merged' | 'declined';

/**
 * A pull request's current state, used to reconcile a raised PR against the
 * catalog.
 *
 * @public
 */
export interface ScmPullRequest extends ScmPullRequestRef {
  state: ScmPullRequestState;
  createdAt?: Date;
  /** When the PR was merged or declined; absent while it is open. */
  closedAt?: Date;
}

// ─── Capabilities ────────────────────────────────────────────────────────────

/**
 * Read access to commit history, used by the top-contributor proposal strategy.
 *
 * @public
 */
export interface ScmHistoryCapability {
  /** Most recent commits on the default branch, newest first, at most `limit`. */
  getCommits(repo: ScmRepoRef, opts: { limit: number }): Promise<ScmCommit[]>;
}

/**
 * Write access used to raise catalog-info pull requests.
 *
 * Every method throws an {@link ScmError} on failure. "Normal" outcomes —
 * a missing file, an existing branch, an already-open PR — are returned, not
 * thrown, so callers can stay idempotent.
 *
 * @public
 */
export interface ScmPullRequestCapability {
  /** Display name of the repository's default branch, e.g. `main`. */
  getDefaultBranch(repo: ScmRepoRef): Promise<string>;
  /** Read `path` at `branch`. `undefined` = the file (or branch) does not exist. */
  readFile(
    repo: ScmRepoRef,
    path: string,
    branch: string,
  ): Promise<ScmFile | undefined>;
  /** Create `name` from `startPoint`. An already-existing branch is `exists`, not an error. */
  createBranch(
    repo: ScmRepoRef,
    name: string,
    startPoint: string,
  ): Promise<'created' | 'exists'>;
  /**
   * Commit `content` to `path` on `branch`. `revision` (from {@link readFile})
   * guards against overwriting a concurrent change: a stale revision throws
   * `ScmError` with kind `conflict`. Omit it to create a file that doesn't
   * exist yet; if it does exist, that is a `conflict` too.
   */
  commitFile(
    repo: ScmRepoRef,
    path: string,
    opts: {
      content: string;
      message: string;
      branch: string;
      revision?: string;
    },
  ): Promise<void>;
  /** The open PR whose source is `fromBranch`, if any. */
  findOpenPullRequest(
    repo: ScmRepoRef,
    fromBranch: string,
  ): Promise<ScmPullRequestRef | undefined>;
  /** A PR by its {@link ScmPullRequestRef.id}, in any state. `undefined` = no such PR (e.g. deleted). */
  getPullRequest(
    repo: ScmRepoRef,
    id: string,
  ): Promise<ScmPullRequest | undefined>;
  /**
   * Open a PR. If one is already open for the same source branch it is
   * returned as `reused`. Invalid reviewers make the provider throw
   * `ScmError` with kind `invalid`.
   */
  createPullRequest(
    repo: ScmRepoRef,
    opts: {
      title: string;
      description: string;
      fromBranch: string;
      toBranch: string;
      /** Provider-native reviewer ids, as returned by {@link resolveReviewer}/{@link getDefaultReviewers}. */
      reviewers?: string[];
    },
  ): Promise<{ status: 'created' | 'reused'; pr: ScmPullRequestRef }>;
  /**
   * Bring an open PR's title/description up to date and add reviewers,
   * keeping existing ones. `unchanged` when nothing differed.
   */
  updatePullRequest(
    repo: ScmRepoRef,
    pr: ScmPullRequestRef,
    desired: { title: string; description: string; addReviewers?: string[] },
  ): Promise<'updated' | 'unchanged'>;
  /** Map an email address to a provider-native reviewer id. `undefined` = no such user. */
  resolveReviewer(repo: ScmRepoRef, email: string): Promise<string | undefined>;
  /** Reviewers the repository requires for a PR between the two branches (provider-native ids). */
  getDefaultReviewers(
    repo: ScmRepoRef,
    opts: { fromBranch: string; toBranch: string },
  ): Promise<string[]>;
}

// ─── Provider contract ───────────────────────────────────────────────────────

/**
 * A client bound to one integration host. Capabilities are optional: a
 * provider that only reads history leaves `pullRequests` undefined, and core
 * degrades gracefully.
 *
 * @public
 */
export interface ScmClient {
  /**
   * Parse a `backstage.io/managed-by-location` target URL (without the `url:`
   * prefix) into a file location. `undefined` = not a file URL this provider
   * understands.
   */
  parseLocation(url: string): ScmFileLocation | undefined;
  history?: ScmHistoryCapability;
  pullRequests?: ScmPullRequestCapability;
}

/**
 * Per-host settings from `ownershipMatcher.scm.hosts`.
 *
 * @public
 */
export interface ScmHostConfig {
  host: string;
  /** Write token; providers must not fall back to the integration's read credentials for writes. */
  writeToken?: string;
}

/**
 * What core hands a provider when it creates a client for one host.
 *
 * @public
 */
export interface ScmProviderContext {
  /** The matched `integrations.*` entry; holds host, API base URL and read credentials. */
  integration: ScmIntegration;
  hostConfig?: ScmHostConfig;
  logger: LoggerService;
  /**
   * `fetch` restricted to the integration's host and API host (SSRF guard).
   * Requests to any other host, or to a non-http(s) scheme, reject.
   */
  fetch: typeof fetch;
}

/**
 * An SCM provider, registered through `ownershipMatcherScmExtensionPoint`.
 *
 * @public
 */
export interface ScmProvider {
  /** Equals the `ScmIntegration.type` this provider serves, e.g. `bitbucketServer`. */
  readonly type: string;
  createClient(ctx: ScmProviderContext): ScmClient | Promise<ScmClient>;
}
