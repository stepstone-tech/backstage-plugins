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

import { mockServices } from '@backstage/backend-test-utils';
import type {
  ScmClient,
  ScmProviderContext,
} from '@stepstone-tech/backstage-plugin-ownership-matcher-node';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseAllDocuments } from 'yaml';
import { MOCK_SCM_TYPE, MockScmProvider } from './MockScmProvider';
import { COMMIT_AUTHORS } from './fixtures';

const HOST = '127.0.0.1:7008';

function makeClient(): ScmClient {
  const provider = new MockScmProvider({
    rootDir: '/tmp/does-not-matter',
    host: HOST,
    mergeAfterMs: 1000,
  });
  const ctx = {
    integration: { type: MOCK_SCM_TYPE },
    logger: mockServices.logger.mock(),
    fetch: globalThis.fetch,
  } as unknown as ScmProviderContext;
  return provider.createClient(ctx);
}

describe('MockScmProvider', () => {
  it('serves the configured integration type', () => {
    expect(
      new MockScmProvider({ rootDir: '/tmp', host: HOST, mergeAfterMs: 0 })
        .type,
    ).toBe(MOCK_SCM_TYPE);
  });

  it('parses a served catalog-info URL into a repo and path', () => {
    const location = makeClient().parseLocation(
      `http://${HOST}/projects/dev/repos/orphaned-service/browse/catalog-info.yaml`,
    );

    expect(location).toEqual({
      repo: {
        type: MOCK_SCM_TYPE,
        host: HOST,
        path: 'dev/orphaned-service',
        webUrl: `http://${HOST}/projects/dev/repos/orphaned-service/browse`,
      },
      path: 'catalog-info.yaml',
    });
  });

  it('returns undefined for a URL on another host', () => {
    expect(
      makeClient().parseLocation(
        'http://example.com/projects/dev/repos/a/browse/catalog-info.yaml',
      ),
    ).toBeUndefined();
  });

  it('returns undefined for a non-catalog-info path', () => {
    // org.yaml and root.yaml are served from the same host; they are not
    // component locations and must not resolve to a repo.
    expect(
      makeClient().parseLocation(
        `http://${HOST}/projects/dev/repos/root/browse/org.yaml`,
      ),
    ).toBeUndefined();
  });

  it('returns undefined for a URL it cannot parse at all', () => {
    expect(makeClient().parseLocation('not a url')).toBeUndefined();
    expect(
      makeClient().parseLocation(`http://${HOST}/something/else`),
    ).toBeUndefined();
  });
});

describe('MockScmProvider history', () => {
  const repo = {
    type: MOCK_SCM_TYPE,
    host: HOST,
    path: 'dev/orphaned-service',
    webUrl: `http://${HOST}/projects/dev/repos/orphaned-service/browse`,
  };

  it('returns commits for a known repo, newest first, capped at limit', async () => {
    const history = makeClient().history!;
    expect(history).toBeDefined();

    const all = await history.getCommits(repo, { limit: 100 });
    const capped = await history.getCommits(repo, { limit: 3 });

    expect(all.length).toBe(COMMIT_AUTHORS[repo.path].length);
    expect(all.map(c => c.author.email)).toEqual(
      COMMIT_AUTHORS[repo.path].map(a => a.email),
    );
    expect(capped).toEqual(all.slice(0, 3));
    expect(new Set(all.map(c => c.id)).size).toBe(all.length);
  });

  it('returns an empty array for a repo with no fixture', async () => {
    await expect(
      makeClient().history!.getCommits(
        { ...repo, path: 'dev/legacy-batch-job' },
        { limit: 25 },
      ),
    ).resolves.toEqual([]);
  });

  it('returns author emails that exist in the sample org', () => {
    const orgYaml = readFileSync(
      resolve(__dirname, '../../../../examples/root/org.yaml'),
      'utf8',
    );
    const userNames = parseAllDocuments(orgYaml)
      .map(doc => doc.toJS() as { kind: string; metadata: { name: string } })
      .filter(doc => doc?.kind === 'User')
      .map(doc => doc.metadata.name);

    const emails = Object.values(COMMIT_AUTHORS).flatMap(authors =>
      authors.map(a => a.email),
    );
    expect(emails.length).toBeGreaterThan(0);
    for (const email of new Set(emails)) {
      // ContributorService matches a commit author to a catalog user by the
      // local part of the address, so a typo here silently scores nothing.
      expect(userNames).toContain(email.split('@')[0]);
    }
  });

  it('gives one repo a dominant team and another a two-team spread', () => {
    const counts = (path: string) =>
      new Set(COMMIT_AUTHORS[path].map(a => a.email)).size;

    expect(counts('dev/orphaned-service')).toBeGreaterThan(1);
    expect(counts('dev/placeholder-owner-library')).toBeGreaterThan(1);
    // The no-commits component is what makes `possible_owner` reachable:
    // org-proximity alone scores it 0.3 * 0.6 / (0.5 + 0.3) = 0.225.
    expect(COMMIT_AUTHORS['dev/docs-portal']).toBeUndefined();
  });
});
