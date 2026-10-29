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

/**
 * Unit tests for DefaultActorResolver — the pure actor-resolution engine
 * extracted from DefaultEscalationService. Covers both the
 * direct-member path and the manager-chain path, plus the single-match
 * `resolveActorForGroup` variant. The resolver only touches the injected
 * catalog contract and the escalation config, so a tiny in-memory catalog stub
 * is sufficient — no DB, clock, scanner or events.
 */

import { LoggerService } from '@backstage/backend-plugin-api';
import { DefaultActorResolver } from './ActorResolver';
import {
  CatalogGroupMember,
  CatalogServiceExtensions,
} from './CatalogServiceExtensions';
import { EscalationConfig, EscalationLevelConfig } from '../config/types';

const logger = {
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  child: jest.fn(),
} as unknown as LoggerService;

/**
 * Minimal in-memory {@link CatalogServiceExtensions} covering only the methods
 * the resolver calls: `getGroupMembersWithTitles`, `getManagerRef`,
 * `getUserJobTitle`. The hierarchy/registry methods throw if hit — the resolver
 * must never call them.
 */
class StubCatalog implements CatalogServiceExtensions {
  private readonly members = new Map<string, CatalogGroupMember[]>();
  /** userRef → { managerRef, jobTitle } */
  private readonly people = new Map<
    string,
    { managerRef?: string; jobTitle?: string }
  >();

  addGroupMembers(groupRef: string, members: CatalogGroupMember[]): this {
    this.members.set(groupRef, members);
    return this;
  }

  /** Register a person's own job title and (optional) manager. */
  addPerson(userRef: string, jobTitle?: string, managerRef?: string): this {
    this.people.set(userRef, { managerRef, jobTitle });
    return this;
  }

  async getGroupMembersWithTitles(
    groupRef: string,
  ): Promise<CatalogGroupMember[]> {
    return this.members.get(groupRef) ?? [];
  }

  async getManagerRef(userRef: string): Promise<string | undefined> {
    return this.people.get(userRef)?.managerRef;
  }

  async getUserJobTitle(userRef: string): Promise<string | undefined> {
    return this.people.get(userRef)?.jobTitle;
  }

  async getLiveGroupRegistry(): Promise<Set<string>> {
    throw new Error('not expected to be called by the resolver');
  }
  async walkGroupHierarchy(): Promise<never> {
    throw new Error('not expected to be called by the resolver');
  }
  async getGroupsByFilter(): Promise<never> {
    throw new Error('not expected to be called by the resolver');
  }
}

const DOMAIN_LEVEL: EscalationLevelConfig = {
  groupFilter: 'Group:domain',
  timeoutDays: 7,
  titlePatterns: ['.*Director.*'],
};

const MANAGER_CHAIN_LEVEL: EscalationLevelConfig = {
  groupFilter: 'Group:domain',
  timeoutDays: 7,
  managerChain: true,
  titlePatterns: ['.*Director.*'],
};

function resolver(
  catalog: CatalogServiceExtensions,
  level: EscalationLevelConfig,
): DefaultActorResolver {
  const config: EscalationConfig = { levels: [level] };
  return new DefaultActorResolver(catalog, config, logger);
}

describe('DefaultActorResolver', () => {
  describe('resolveAllActorsForGroup — direct-member path', () => {
    it('returns the single Director member of a group', async () => {
      const catalog = new StubCatalog().addGroupMembers(
        'group:default/domain-search',
        [
          {
            userRef: 'user:default/jane.director',
            jobTitle: 'Engineering Director',
          },
          { userRef: 'user:default/ic', jobTitle: 'Software Engineer' },
        ],
      );

      const result = await resolver(
        catalog,
        DOMAIN_LEVEL,
      ).resolveAllActorsForGroup('group:default/domain-search', 1);

      expect(result).toEqual(['user:default/jane.director']);
    });

    it('returns ALL matching members, deduped, in discovery order', async () => {
      const catalog = new StubCatalog().addGroupMembers(
        'group:default/domain-x',
        [
          {
            userRef: 'user:default/dir.one',
            jobTitle: 'Engineering Director, Alpha',
          },
          {
            userRef: 'user:default/dir.two',
            jobTitle: 'Engineering Director, Beta',
          },
          { userRef: 'user:default/ic.one', jobTitle: 'Software Engineer' },
        ],
      );

      const result = await resolver(
        catalog,
        DOMAIN_LEVEL,
      ).resolveAllActorsForGroup('group:default/domain-x', 1);

      expect(result).toEqual(['user:default/dir.one', 'user:default/dir.two']);
    });

    it('returns [] when no member title matches', async () => {
      const catalog = new StubCatalog().addGroupMembers(
        'group:default/team-a',
        [{ userRef: 'user:default/alice', jobTitle: 'Software Engineer' }],
      );

      const result = await resolver(
        catalog,
        DOMAIN_LEVEL,
      ).resolveAllActorsForGroup('group:default/team-a', 1);

      expect(result).toEqual([]);
    });

    it('returns [] for an out-of-range level', async () => {
      const catalog = new StubCatalog();
      expect(
        await resolver(catalog, DOMAIN_LEVEL).resolveAllActorsForGroup(
          'group:default/domain-search',
          5,
        ),
      ).toEqual([]);
    });

    it('returns [] when the level has no titlePatterns', async () => {
      const catalog = new StubCatalog().addGroupMembers(
        'group:default/domain-x',
        [{ userRef: 'user:default/dir.one', jobTitle: 'Engineering Director' }],
      );
      const noPatterns: EscalationLevelConfig = {
        groupFilter: 'Group:domain',
        timeoutDays: 7,
      };

      const result = await resolver(
        catalog,
        noPatterns,
      ).resolveAllActorsForGroup('group:default/domain-x', 1);

      expect(result).toEqual([]);
    });
  });

  describe('resolveAllActorsForGroup — manager-chain path', () => {
    it('walks each team member up to a matching manager and collects all', async () => {
      const catalog = new StubCatalog()
        .addGroupMembers('group:default/team-y', [
          { userRef: 'user:default/eng.one', jobTitle: 'Software Engineer' },
          { userRef: 'user:default/eng.two', jobTitle: 'Software Engineer' },
        ])
        .addPerson(
          'user:default/eng.one',
          'Software Engineer',
          'user:default/lead.one',
        )
        .addPerson('user:default/lead.one', 'Team Lead', 'user:default/dir.a')
        .addPerson('user:default/dir.a', 'Engineering Director')
        .addPerson(
          'user:default/eng.two',
          'Software Engineer',
          'user:default/dir.b',
        )
        .addPerson('user:default/dir.b', 'Engineering Director');

      const result = await resolver(
        catalog,
        MANAGER_CHAIN_LEVEL,
      ).resolveAllActorsForGroup('group:default/domain-y', 1, [
        'group:default/team-y',
      ]);

      expect(result.sort()).toEqual([
        'user:default/dir.a',
        'user:default/dir.b',
      ]);
    });

    it('returns [] when the manager chain yields no matching title', async () => {
      const catalog = new StubCatalog()
        .addGroupMembers('group:default/team-z', [
          { userRef: 'user:default/eng.z', jobTitle: 'Software Engineer' },
        ])
        .addPerson(
          'user:default/eng.z',
          'Software Engineer',
          'user:default/lead.z',
        )
        .addPerson('user:default/lead.z', 'Team Lead');

      const result = await resolver(
        catalog,
        MANAGER_CHAIN_LEVEL,
      ).resolveAllActorsForGroup('group:default/domain-z', 1, [
        'group:default/team-z',
      ]);

      expect(result).toEqual([]);
    });

    it('stops at the NEAREST matching manager per member', async () => {
      const catalog = new StubCatalog()
        .addGroupMembers('group:default/team-w', [
          { userRef: 'user:default/eng.w', jobTitle: 'Software Engineer' },
        ])
        .addPerson(
          'user:default/eng.w',
          'Software Engineer',
          'user:default/dir.w',
        )
        .addPerson(
          'user:default/dir.w',
          'Engineering Director',
          'user:default/vp.w',
        )
        .addPerson('user:default/vp.w', 'VP, Director of Engineering');

      const result = await resolver(
        catalog,
        MANAGER_CHAIN_LEVEL,
      ).resolveAllActorsForGroup('group:default/domain-w', 1, [
        'group:default/team-w',
      ]);

      expect(result).toEqual(['user:default/dir.w']);
    });
  });

  describe('resolveActorForGroup — single-match variant', () => {
    it('returns the first matching actor only', async () => {
      const catalog = new StubCatalog().addGroupMembers(
        'group:default/domain-x',
        [
          { userRef: 'user:default/dir.one', jobTitle: 'Engineering Director' },
          { userRef: 'user:default/dir.two', jobTitle: 'Engineering Director' },
        ],
      );

      const result = await resolver(catalog, DOMAIN_LEVEL).resolveActorForGroup(
        'group:default/domain-x',
        1,
      );

      expect(result).toBe('user:default/dir.one');
    });

    it('returns undefined when nothing matches', async () => {
      const catalog = new StubCatalog().addGroupMembers(
        'group:default/team-a',
        [{ userRef: 'user:default/alice', jobTitle: 'Software Engineer' }],
      );

      const result = await resolver(catalog, DOMAIN_LEVEL).resolveActorForGroup(
        'group:default/team-a',
        1,
      );

      expect(result).toBeUndefined();
    });
  });
});
