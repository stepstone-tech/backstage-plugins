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

import {
  bitbucketServerRepo,
  parseBitbucketServerLocation,
  trimTrailingSlashes,
} from './location';

const HOST = 'repo.example.com';

describe('parseBitbucketServerLocation', () => {
  it('parses project, repo and decoded file path', () => {
    expect(
      parseBitbucketServerLocation(
        `https://${HOST}/projects/PROJ/repos/my-repo/browse/src/My%20Service/catalog-info.yaml`,
        HOST,
      ),
    ).toEqual({
      repo: {
        type: 'bitbucketServer',
        host: HOST,
        path: 'PROJ/my-repo',
        webUrl: `https://${HOST}/projects/PROJ/repos/my-repo/browse`,
      },
      path: 'src/My Service/catalog-info.yaml',
    });
  });

  it('extracts the branch from ?at=', () => {
    expect(
      parseBitbucketServerLocation(
        `https://${HOST}/projects/PROJ/repos/other-repo/browse/catalog-info.yaml?at=refs%2Fheads%2Fdevelop`,
        HOST,
      ),
    ).toMatchObject({ ref: 'develop', path: 'catalog-info.yaml' });
  });

  it('keeps the scheme of the location in webUrl (same value as the legacy repo_url)', () => {
    expect(
      parseBitbucketServerLocation(
        `http://${HOST}/projects/P/repos/r/browse/a.yaml`,
        HOST,
      )?.repo.webUrl,
    ).toBe(`http://${HOST}/projects/P/repos/r/browse`);
  });

  it('supports Bitbucket served under a context path', () => {
    expect(
      parseBitbucketServerLocation(
        `https://${HOST}/bitbucket/projects/P/repos/r/browse/a.yaml?at=refs%2Fheads%2Fdev`,
        HOST,
      ),
    ).toEqual({
      repo: {
        type: 'bitbucketServer',
        host: HOST,
        path: 'P/r',
        webUrl: `https://${HOST}/bitbucket/projects/P/repos/r/browse`,
      },
      path: 'a.yaml',
      ref: 'dev',
    });
  });

  it.each([
    '',
    'not a url',
    'https://github.com/org/repo/blob/main/catalog-info.yaml',
    `https://${HOST}/projects/PROJ/repos/other-repo/browse/`,
    `https://${HOST}/projects/PROJ/repos/other-repo/browse`,
    `https://other.example.com/projects/PROJ/repos/other-repo/browse/catalog-info.yaml`,
    `https://${HOST}/projects/PROJ/repos/other-repo/browse/%E0%A4%A.yaml`,
  ])('returns undefined for unsupported location %p', value => {
    expect(parseBitbucketServerLocation(value, HOST)).toBeUndefined();
  });
});

describe('bitbucketServerRepo', () => {
  it('builds the repo ref from an origin, project and slug', () => {
    expect(bitbucketServerRepo(`https://${HOST}`, 'PROJ', 'my-repo')).toEqual({
      type: 'bitbucketServer',
      host: HOST,
      path: 'PROJ/my-repo',
      webUrl: `https://${HOST}/projects/PROJ/repos/my-repo/browse`,
    });
  });
});

describe('trimTrailingSlashes', () => {
  it.each([
    ['https://h/ctx///', 'https://h/ctx'],
    ['/', ''],
    ['', ''],
    ['a/b', 'a/b'],
  ])('%p → %p', (input, output) => {
    expect(trimTrailingSlashes(input)).toBe(output);
  });

  it('stays linear on a long run of slashes not at the end', () => {
    const input = `${'/'.repeat(100_000)}x`;
    const started = Date.now();
    expect(trimTrailingSlashes(input)).toBe(input);
    expect(Date.now() - started).toBeLessThan(100);
  });
});
