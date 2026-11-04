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

import { ContributorService } from './ContributorService';
import { CatalogService } from '@stepstone-tech/backstage-plugin-ownership-matcher-node';
import { mockServices } from '@backstage/backend-test-utils';
import { ContributorsConfig } from '../config/types';

const ALIAS_ANNOTATION = 'example.com/alias';

function makeConfig(
  overrides: Partial<ContributorsConfig> = {},
): ContributorsConfig {
  return {
    excludeEmails: [],
    excludePatterns: [],
    excludeUsernames: [],
    ...overrides,
  };
}

function makeCatalogService(
  users: Array<{
    name: string;
    memberOf?: string[];
    sam?: string;
    profileEmail?: string;
    /** Omit `spec.memberOf` entirely. */
    noMembership?: boolean;
  }> = [],
): CatalogService {
  const items = users.map(u => ({
    kind: 'User',
    metadata: {
      name: u.name,
      ...(u.sam ? { annotations: { [ALIAS_ANNOTATION]: u.sam } } : {}),
    },
    spec: {
      ...(u.noMembership ? {} : { memberOf: u.memberOf ?? [] }),
      ...(u.profileEmail ? { profile: { email: u.profileEmail } } : {}),
    },
  }));
  return {
    getUserData: jest.fn().mockResolvedValue(items),
  } as unknown as CatalogService;
}

describe('ContributorService', () => {
  const logger = mockServices.logger.mock();

  // ── isBot ──────────────────────────────────────────────────────────────────

  describe('isBot', () => {
    it('returns false when no exclusions configured', () => {
      const svc = new ContributorService(
        makeCatalogService(),
        logger,
        makeConfig(),
      );
      expect(svc.isBot('dev@example.com')).toBe(false);
    });

    it('excludes exact email match (case-insensitive)', () => {
      const svc = new ContributorService(
        makeCatalogService(),
        logger,
        makeConfig({ excludeEmails: ['CI-BOT@example.com'] }),
      );
      expect(svc.isBot('ci-bot@example.com')).toBe(true);
      expect(svc.isBot('other@example.com')).toBe(false);
    });

    it('excludes by username prefix', () => {
      const svc = new ContributorService(
        makeCatalogService(),
        logger,
        makeConfig({ excludeUsernames: ['bob'] }),
      );
      expect(svc.isBot('bob@example.com')).toBe(true);
      expect(svc.isBot('alice@example.com')).toBe(false);
    });

    it('excludes by regex pattern', () => {
      const svc = new ContributorService(
        makeCatalogService(),
        logger,
        makeConfig({ excludePatterns: ['.*-bot@.*'] }),
      );
      expect(svc.isBot('deploy-bot@example.com')).toBe(true);
      expect(svc.isBot('alice@example.com')).toBe(false);
    });

    it('matches pattern case-insensitively', () => {
      const svc = new ContributorService(
        makeCatalogService(),
        logger,
        makeConfig({ excludePatterns: ['.*BOT.*'] }),
      );
      expect(svc.isBot('deploy-bot@example.com')).toBe(true);
    });
  });

  // ── getContributorInfo ─────────────────────────────────────────────────────

  describe('getContributorInfo', () => {
    it('returns null for bot emails', async () => {
      const svc = new ContributorService(
        makeCatalogService(),
        logger,
        makeConfig({ excludeEmails: ['bot@example.com'] }),
      );
      expect(await svc.getContributorInfo('bot@example.com')).toBeNull();
    });

    it('resolves email to teams via catalog', async () => {
      const catalog = makeCatalogService([
        {
          name: 'alice',
          memberOf: ['group:default/team-a', 'group:default/team-b'],
        },
      ]);
      const svc = new ContributorService(
        catalog,
        logger,
        makeConfig(),
        ALIAS_ANNOTATION,
      );

      const info = await svc.getContributorInfo('alice@example.com');

      expect(info).not.toBeNull();
      expect(info!.teams).toEqual(expect.arrayContaining(['team-a', 'team-b']));
    });

    it('returns null when user not found in catalog', async () => {
      const catalog = makeCatalogService([
        { name: 'alice', memberOf: ['group:default/team-a'] },
      ]);
      const svc = new ContributorService(
        catalog,
        logger,
        makeConfig(),
        ALIAS_ANNOTATION,
      );
      expect(await svc.getContributorInfo('unknown@example.com')).toBeNull();
    });

    it('caches results — catalog called only once for repeated email', async () => {
      const catalog = makeCatalogService([
        { name: 'alice', memberOf: ['group:default/team-a'] },
      ]);
      const svc = new ContributorService(
        catalog,
        logger,
        makeConfig(),
        ALIAS_ANNOTATION,
      );

      const first = await svc.getContributorInfo('alice@example.com');
      const second = await svc.getContributorInfo('alice@example.com');

      // Second call hits the contributor cache — getUserData only called once.
      expect(catalog.getUserData).toHaveBeenCalledTimes(1);
      expect(second).toBe(first);
    });

    it('caches user data — getUserData called once even for different emails', async () => {
      const catalog = makeCatalogService([
        { name: 'alice', memberOf: ['group:default/team-a'] },
        { name: 'bob', memberOf: ['group:default/team-b'] },
      ]);
      const svc = new ContributorService(
        catalog,
        logger,
        makeConfig(),
        ALIAS_ANNOTATION,
      );

      await svc.getContributorInfo('alice@example.com');
      await svc.getContributorInfo('bob@example.com');

      // User data is fetched once and cached at the service level.
      expect(catalog.getUserData).toHaveBeenCalledTimes(1);
    });

    it('matches by username prefix ignoring underscore suffix', async () => {
      const catalog = makeCatalogService([
        { name: 'bob', memberOf: ['group:default/team-c'] },
      ]);
      const svc = new ContributorService(
        catalog,
        logger,
        makeConfig(),
        ALIAS_ANNOTATION,
      );

      const info = await svc.getContributorInfo('bob_external@example.com');

      expect(info).not.toBeNull();
      expect(info!.teams).toContain('team-c');
    });

    it('falls back to the SAM account name when the name prefix does not match', async () => {
      const catalog = makeCatalogService([
        {
          name: 'john.doe',
          sam: 'doej02',
          memberOf: ['group:default/team-a'],
        },
      ]);
      const svc = new ContributorService(
        catalog,
        logger,
        makeConfig(),
        ALIAS_ANNOTATION,
      );

      const info = await svc.getContributorInfo('doej02@example.com');

      expect(info).toEqual({
        email: 'doej02@example.com',
        teams: ['team-a'],
      });
    });

    it.each([
      ['SmithJ01', 'smithj01@example.com'],
      ['smithj01', 'SmithJ01@example.com'],
    ])('matches SAM %s against %s case-insensitively', async (sam, email) => {
      const catalog = makeCatalogService([
        { name: 'jane.smith', sam, memberOf: ['group:default/team-a'] },
      ]);
      const svc = new ContributorService(
        catalog,
        logger,
        makeConfig(),
        ALIAS_ANNOTATION,
      );

      expect((await svc.getContributorInfo(email))?.teams).toEqual(['team-a']);
    });

    it('skips the alias match when no alias annotation is configured', async () => {
      const catalog = makeCatalogService([
        {
          name: 'john.doe',
          sam: 'doej02',
          memberOf: ['group:default/team-a'],
        },
      ]);
      const svc = new ContributorService(catalog, logger, makeConfig());

      expect(await svc.getContributorInfo('doej02@example.com')).toBeNull();
    });

    it('returns null when neither the name prefix nor the SAM matches', async () => {
      const catalog = makeCatalogService([
        {
          name: 'john.doe',
          sam: 'doej02',
          memberOf: ['group:default/team-a'],
        },
        { name: 'bob', memberOf: ['group:default/team-b'] },
      ]);
      const svc = new ContributorService(
        catalog,
        logger,
        makeConfig(),
        ALIAS_ANNOTATION,
      );

      expect(await svc.getContributorInfo('nobody01@example.com')).toBeNull();
    });

    it('matches the full commit email against spec.profile.email case-insensitively', async () => {
      const catalog = makeCatalogService([
        {
          name: 'jdoe',
          profileEmail: 'Jane.Doe@Example.com',
          memberOf: ['group:default/team-a'],
        },
      ]);
      const svc = new ContributorService(
        catalog,
        logger,
        makeConfig(),
        ALIAS_ANNOTATION,
      );

      expect(await svc.getContributorInfo('jane.doe@example.com')).toEqual({
        email: 'jane.doe@example.com',
        teams: ['team-a'],
      });
    });

    it('prefers a profile-email match over a name-prefix match on another user', async () => {
      const catalog = makeCatalogService([
        { name: 'alice', memberOf: ['group:default/team-name'] },
        {
          name: 'a.smith',
          profileEmail: 'alice@example.com',
          memberOf: ['group:default/team-email'],
        },
      ]);
      const svc = new ContributorService(
        catalog,
        logger,
        makeConfig(),
        ALIAS_ANNOTATION,
      );

      expect(
        (await svc.getContributorInfo('alice@example.com'))?.teams,
      ).toEqual(['team-email']);
    });

    it('falls back to the name-prefix match when the profile email differs', async () => {
      const catalog = makeCatalogService([
        {
          name: 'bob',
          profileEmail: 'robert@corp.example.com',
          memberOf: ['group:default/team-b'],
        },
      ]);
      const svc = new ContributorService(
        catalog,
        logger,
        makeConfig(),
        ALIAS_ANNOTATION,
      );

      expect((await svc.getContributorInfo('bob@example.com'))?.teams).toEqual([
        'team-b',
      ]);
    });

    it('skips a profile-email match without memberOf so a later match still wins', async () => {
      const catalog = makeCatalogService([
        {
          name: 'ghost',
          profileEmail: 'carol@example.com',
          noMembership: true,
        },
        { name: 'carol', memberOf: ['group:default/team-c'] },
      ]);
      const svc = new ContributorService(
        catalog,
        logger,
        makeConfig(),
        ALIAS_ANNOTATION,
      );

      expect(
        (await svc.getContributorInfo('carol@example.com'))?.teams,
      ).toEqual(['team-c']);
    });

    it('prefers the name-prefix match over a SAM match on another user', async () => {
      const catalog = makeCatalogService([
        {
          name: 'other.person',
          sam: 'alice',
          memberOf: ['group:default/team-sam'],
        },
        { name: 'alice', memberOf: ['group:default/team-name'] },
      ]);
      const svc = new ContributorService(
        catalog,
        logger,
        makeConfig(),
        ALIAS_ANNOTATION,
      );

      expect(
        (await svc.getContributorInfo('alice@example.com'))?.teams,
      ).toEqual(['team-name']);
    });

    // CatalogService.getUserData returns [] on a catalog error; caching that
    // would make every later lookup read as "unknown user".
    it('throws and does not cache when the catalog returns no users', async () => {
      const catalog = makeCatalogService([]);
      const svc = new ContributorService(
        catalog,
        logger,
        makeConfig(),
        ALIAS_ANNOTATION,
      );

      await expect(svc.getContributorInfo('alice@example.com')).rejects.toThrow(
        'Catalog user data unavailable',
      );

      (catalog.getUserData as jest.Mock).mockResolvedValue([
        {
          kind: 'User',
          metadata: { name: 'alice' },
          spec: { memberOf: ['group:default/team-a'] },
        },
      ]);
      const info = await svc.getContributorInfo('alice@example.com');

      expect(info?.teams).toEqual(['team-a']);
      expect(catalog.getUserData).toHaveBeenCalledTimes(2);
    });

    it('resetCache drops the cached user data so the next lookup refetches', async () => {
      const catalog = makeCatalogService([
        { name: 'alice', memberOf: ['group:default/team-a'] },
      ]);
      const svc = new ContributorService(
        catalog,
        logger,
        makeConfig(),
        ALIAS_ANNOTATION,
      );
      await svc.getContributorInfo('alice@example.com');

      svc.resetCache();
      await svc.getContributorInfo('alice@example.com');

      expect(catalog.getUserData).toHaveBeenCalledTimes(2);
    });

    it('resets cache', async () => {
      const catalog = makeCatalogService([
        { name: 'alice', memberOf: ['group:default/team-a'] },
      ]);
      const svc = new ContributorService(
        catalog,
        logger,
        makeConfig(),
        ALIAS_ANNOTATION,
      );
      const first = await svc.getContributorInfo('alice@example.com');
      expect(await svc.getContributorInfo('alice@example.com')).toBe(first);

      svc.resetCache();
      expect(await svc.getContributorInfo('alice@example.com')).not.toBe(first);
    });
  });
});
