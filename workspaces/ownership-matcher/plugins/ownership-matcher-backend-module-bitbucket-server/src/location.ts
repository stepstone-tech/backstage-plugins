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

export const BITBUCKET_SERVER_TYPE = 'bitbucketServer';

/** Drop trailing `/`s. A loop, not `/\/+$/`, which backtracks quadratically on long `/` runs. */
export function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === '/') end--;
  return value.slice(0, end);
}

/**
 * The {@link ScmRepoRef} of a Bitbucket Server repository: `path` is
 * `<PROJECT>/<repo>`, `webUrl` the repository's browse page.
 *
 * @public
 */
export function bitbucketServerRepo(
  baseUrl: string,
  projectKey: string,
  repoSlug: string,
): ScmRepoRef {
  // `baseUrl` may carry a context path, e.g. `https://host/bitbucket`.
  const url = new URL(baseUrl);
  const base = `${url.origin}${trimTrailingSlashes(url.pathname)}`;
  return {
    type: BITBUCKET_SERVER_TYPE,
    host: url.host,
    path: `${projectKey}/${repoSlug}`,
    webUrl: `${base}/projects/${encodeURIComponent(
      projectKey,
    )}/repos/${encodeURIComponent(repoSlug)}/browse`,
  };
}

/** `PROJ/repo` → `{ projectKey, repoSlug }`; anything else is not a Bitbucket Server repo path. */
export function splitRepoPath(
  repo: ScmRepoRef,
): { projectKey: string; repoSlug: string } | undefined {
  const parts = repo.path.split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return undefined;
  return { projectKey: parts[0], repoSlug: parts[1] };
}

/**
 * Parse a `managed-by-location` target of the form
 * `https://<host>[/<context>]/projects/<KEY>/repos/<repo>/browse/<path>[?at=refs/heads/<branch>]`.
 * Only URLs on `host` are accepted; a context path (Bitbucket served under
 * e.g. `/bitbucket`) is kept in `webUrl`. A browse URL without a file path is
 * not a file location.
 */
export function parseBitbucketServerLocation(
  url: string,
  host: string,
): ScmFileLocation | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (parsed.host !== host) return undefined;

  const match = /^(.*?)\/projects\/([^/]+)\/repos\/([^/]+)\/browse\/(.+)$/.exec(
    parsed.pathname,
  );
  if (!match) return undefined;

  let projectKey: string;
  let repoSlug: string;
  let path: string;
  try {
    projectKey = decodeURIComponent(match[2]);
    repoSlug = decodeURIComponent(match[3]);
    path = match[4].split('/').map(decodeURIComponent).join('/');
  } catch {
    return undefined;
  }
  if (!path || path.endsWith('/')) return undefined;

  const at = parsed.searchParams.get('at');
  const ref = at ? at.replace(/^refs\/heads\//, '') : undefined;

  return {
    repo: bitbucketServerRepo(
      `${parsed.origin}${match[1]}`,
      projectKey,
      repoSlug,
    ),
    path,
    ...(ref ? { ref } : {}),
  };
}
