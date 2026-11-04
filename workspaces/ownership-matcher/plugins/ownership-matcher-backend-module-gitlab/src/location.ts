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

import type {
  ScmFileLocation,
  ScmRepoRef,
} from '@stepstone-tech/backstage-plugin-ownership-matcher-node';

export const GITLAB_TYPE = 'gitlab';

/** Drop trailing `/`s. A loop, not `/\/+$/`, which backtracks quadratically on long `/` runs. */
export function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === '/') end--;
  return value.slice(0, end);
}

/** A full commit SHA (SHA-1 or SHA-256): a pinned commit, not a branch. */
const COMMIT_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

/**
 * The {@link ScmRepoRef} of a GitLab project: `path` is the full project path
 * including any (nested) groups, e.g. `group/sub/project`; `webUrl` its page.
 *
 * @public
 */
export function gitlabRepo(baseUrl: string, projectPath: string): ScmRepoRef {
  // `baseUrl` may carry a relative path, e.g. `https://host/gitlab`.
  const url = new URL(baseUrl);
  const base = `${url.origin}${trimTrailingSlashes(url.pathname)}`;
  return {
    type: GITLAB_TYPE,
    host: url.host,
    path: projectPath,
    webUrl: `${base}/${projectPath
      .split('/')
      .map(encodeURIComponent)
      .join('/')}`,
  };
}

/**
 * Parse a `managed-by-location` target of the form
 * `<baseUrl>/<group>[/<subgroup>...]/<project>/-/blob/<ref>/<path>`.
 * Only URLs on `host` (and under `baseUrl`'s relative path, for a GitLab
 * served under e.g. `/gitlab`) are accepted. Directory (`/-/tree/`) and
 * repository-root URLs are not file locations.
 *
 * `ref` is taken as the first segment after `/-/blob/`, so a branch name
 * containing `/` can't be told apart from the file path (as in Backstage's own
 * GitLab URL parsing). A full commit SHA is dropped: it pins a commit, not a
 * branch to raise a merge request against.
 */
export function parseGitLabLocation(
  url: string,
  config: { host: string; baseUrl: string },
): ScmFileLocation | undefined {
  let parsed: URL;
  let base: URL;
  try {
    parsed = new URL(url);
    base = new URL(config.baseUrl);
  } catch {
    return undefined;
  }
  if (parsed.host !== config.host) return undefined;

  const prefix = trimTrailingSlashes(base.pathname);
  if (prefix && !parsed.pathname.startsWith(`${prefix}/`)) return undefined;
  const rest = parsed.pathname.slice(prefix.length);

  const match = /^\/(.+?)\/-\/blob\/([^/]+)\/(.+)$/.exec(rest);
  if (!match) return undefined;

  let projectPath: string;
  let ref: string;
  let path: string;
  try {
    projectPath = match[1].split('/').map(decodeURIComponent).join('/');
    ref = decodeURIComponent(match[2]);
    path = match[3].split('/').map(decodeURIComponent).join('/');
  } catch {
    return undefined;
  }
  if (projectPath.split('/').some(segment => !segment)) return undefined;
  if (!path || path.endsWith('/')) return undefined;

  return {
    repo: gitlabRepo(`${parsed.origin}${prefix}`, projectPath),
    path,
    ...(ref && !COMMIT_SHA.test(ref) ? { ref } : {}),
  };
}
