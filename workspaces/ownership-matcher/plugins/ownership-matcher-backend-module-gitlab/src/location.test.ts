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

import { gitlabRepo, parseGitLabLocation } from './location';

const GITLAB_COM = { host: 'gitlab.com', baseUrl: 'https://gitlab.com' };
const SELF_MANAGED = {
  host: 'code.example.com',
  baseUrl: 'https://code.example.com/gitlab',
};

describe('gitlabRepo', () => {
  it('builds the repo ref with the project page as webUrl', () => {
    expect(gitlabRepo('https://gitlab.com', 'acme/platform/svc')).toEqual({
      type: 'gitlab',
      host: 'gitlab.com',
      path: 'acme/platform/svc',
      webUrl: 'https://gitlab.com/acme/platform/svc',
    });
  });

  it('keeps a relative base path and drops trailing slashes', () => {
    expect(
      gitlabRepo('https://code.example.com/gitlab/', 'acme/svc').webUrl,
    ).toBe('https://code.example.com/gitlab/acme/svc');
  });
});

describe('parseGitLabLocation', () => {
  it('parses a blob URL in a nested group', () => {
    expect(
      parseGitLabLocation(
        'https://gitlab.com/acme/platform/team/svc/-/blob/main/catalog-info.yaml',
        GITLAB_COM,
      ),
    ).toEqual({
      repo: {
        type: 'gitlab',
        host: 'gitlab.com',
        path: 'acme/platform/team/svc',
        webUrl: 'https://gitlab.com/acme/platform/team/svc',
      },
      path: 'catalog-info.yaml',
      ref: 'main',
    });
  });

  it('decodes path segments and keeps nested file paths', () => {
    expect(
      parseGitLabLocation(
        'https://gitlab.com/acme/svc/-/blob/develop/src/My%20Service/catalog-info.yaml?ref_type=heads',
        GITLAB_COM,
      ),
    ).toMatchObject({
      repo: { path: 'acme/svc' },
      path: 'src/My Service/catalog-info.yaml',
      ref: 'develop',
    });
  });

  it('drops a commit SHA ref', () => {
    const location = parseGitLabLocation(
      'https://gitlab.com/acme/svc/-/blob/0123456789abcdef0123456789abcdef01234567/catalog-info.yaml',
      GITLAB_COM,
    );
    expect(location?.path).toBe('catalog-info.yaml');
    expect(location).not.toHaveProperty('ref');
  });

  it('handles a GitLab served under a relative path', () => {
    expect(
      parseGitLabLocation(
        'https://code.example.com/gitlab/acme/svc/-/blob/main/catalog-info.yaml',
        SELF_MANAGED,
      ),
    ).toEqual({
      repo: {
        type: 'gitlab',
        host: 'code.example.com',
        path: 'acme/svc',
        webUrl: 'https://code.example.com/gitlab/acme/svc',
      },
      path: 'catalog-info.yaml',
      ref: 'main',
    });
    expect(
      parseGitLabLocation(
        'https://code.example.com/acme/svc/-/blob/main/catalog-info.yaml',
        SELF_MANAGED,
      ),
    ).toBeUndefined();
  });

  it.each([
    ['another host', 'https://evil.example.com/acme/svc/-/blob/main/c.yaml'],
    ['the repo root', 'https://gitlab.com/acme/svc'],
    ['a tree URL', 'https://gitlab.com/acme/svc/-/tree/main/docs'],
    ['a blob URL without a file', 'https://gitlab.com/acme/svc/-/blob/main/'],
    ['a directory path', 'https://gitlab.com/acme/svc/-/blob/main/docs/'],
    ['a legacy blob URL', 'https://gitlab.com/acme/svc/blob/main/c.yaml'],
    [
      'an empty group segment',
      'https://gitlab.com/acme//svc/-/blob/main/c.yaml',
    ],
    [
      'a malformed escape',
      'https://gitlab.com/acme/svc/-/blob/main/%E0%A4%A.yaml',
    ],
    ['not a URL', 'not a url'],
  ])('returns undefined for %s', (_name, url) => {
    expect(parseGitLabLocation(url, GITLAB_COM)).toBeUndefined();
  });
});
