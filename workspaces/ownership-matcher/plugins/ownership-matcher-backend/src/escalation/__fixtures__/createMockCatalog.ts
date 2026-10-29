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
  CatalogServiceExtensions,
  CatalogGroupSummary,
  CatalogGroupMember,
  GroupFilter,
} from '@stepstone-tech/backstage-plugin-ownership-matcher-node';

/**
 * Stateful catalog factory for escalation tests.
 *
 * - `addGroup(ref, specType, parent?)` registers a group and optionally links
 * it to a parent via `childOf`
 * - `addUser(ref, jobTitle, memberOfRef)` registers a user as a member of a
 * group
 * - `removeGroup(ref)` dissolves a group (simulates a reorg)
 * - Returned object also implements `CatalogServiceExtensions` so it can be
 * injected directly wherever that interface is required.
 *
 * Used across almost all test files. Extend this factory rather than building
 * one-off catalogs for each scenario.
 */

interface GroupEntry {
  ref: string;
  kind: string;
  specType: string | undefined;
  /** Parent group ref (childOf relation). */
  parentRef: string | undefined;
  members: MemberEntry[];
}

interface MemberEntry {
  userRef: string;
  jobTitle: string | undefined;
}

interface UserEntry {
  jobTitle: string | undefined;
  managerRef: string | undefined;
}

interface SystemEntry {
  ref: string;
  name: string;
  owner: string | undefined;
}

export interface MockCatalog extends CatalogServiceExtensions {
  addGroup(
    ref: string,
    opts?: { specType?: string; parentRef?: string; kind?: string },
  ): void;
  addUser(ref: string, jobTitle: string | undefined, memberOfRef: string): void;
  /**
   * Register a user's manager + job title so the manager-chain path
   * (`getManagerRef` / `getUserJobTitle`) resolves. Chain managers together by
   * calling this for each link.
   */
  addManager(
    userRef: string,
    managerRef: string | undefined,
    jobTitle?: string,
  ): void;
  /** Register a System entity resolvable via `getEntityByRef`. */
  addSystem(ref: string, opts?: { name?: string; owner?: string }): void;
  /** Fetch a registered System entity by ref (used by `OrgProximityStrategy`). */
  getEntityByRef(entityRef: string): Promise<
    | {
        kind: string;
        metadata: { name: string; namespace: string };
        spec?: { owner?: string };
      }
    | undefined
  >;
  removeGroup(ref: string): void;
  /** Returns true if the given group ref is registered. */
  hasGroup(ref: string): boolean;
  /** Simulate `isUserMemberOfGroup` — forwarded through here for retrigger auth tests. */
  isUserMemberOfGroup(userRef: string, groupRef: string): Promise<boolean>;
}

export function createMockCatalog(): MockCatalog {
  const groups = new Map<string, GroupEntry>();
  const users = new Map<string, UserEntry>();
  const systems = new Map<string, SystemEntry>();

  function parseKind(ref: string): string {
    const [kind] = ref.split(':');
    return kind.charAt(0).toUpperCase() + kind.slice(1);
  }

  const catalog: MockCatalog = {
    addGroup(ref, opts = {}) {
      const kind = opts.kind ?? parseKind(ref);
      groups.set(ref, {
        ref,
        kind,
        specType: opts.specType,
        parentRef: opts.parentRef,
        members: [],
      });
    },

    addUser(ref, jobTitle, memberOfRef) {
      const group = groups.get(memberOfRef);
      if (!group) {
        throw new Error(
          `createMockCatalog: group '${memberOfRef}' not found — call addGroup first`,
        );
      }
      group.members.push({ userRef: ref, jobTitle });
      const existing = users.get(ref);
      users.set(ref, {
        jobTitle: jobTitle ?? existing?.jobTitle,
        managerRef: existing?.managerRef,
      });
    },

    addManager(userRef, managerRef, jobTitle) {
      const existing = users.get(userRef);
      users.set(userRef, {
        jobTitle: jobTitle ?? existing?.jobTitle,
        managerRef,
      });
    },

    addSystem(ref, opts = {}) {
      const name = opts.name ?? ref.split('/').pop() ?? ref;
      systems.set(ref, { ref, name, owner: opts.owner });
    },

    async getEntityByRef(entityRef) {
      const system = systems.get(entityRef);
      if (!system) return undefined;
      const [, namespaceAndName] = system.ref.split(':');
      const namespace = namespaceAndName?.split('/')[0] ?? 'default';
      return {
        kind: 'System',
        metadata: { name: system.name, namespace },
        spec: { owner: system.owner },
      };
    },

    removeGroup(ref) {
      groups.delete(ref);
    },

    hasGroup(ref) {
      return groups.has(ref);
    },

    async getLiveGroupRegistry(): Promise<Set<string>> {
      return new Set(groups.keys());
    },

    async getGroupMembersWithTitles(
      groupRef: string,
    ): Promise<CatalogGroupMember[]> {
      const group = groups.get(groupRef);
      if (!group) return [];
      return group.members.map(m => ({
        userRef: m.userRef,
        jobTitle: m.jobTitle,
      }));
    },

    async walkGroupHierarchy(
      startRef: string,
      direction: 'up' | 'down',
    ): Promise<CatalogGroupSummary[]> {
      const visited: CatalogGroupSummary[] = [];
      const queue = [startRef];
      const seen = new Set<string>([startRef]);

      while (queue.length > 0) {
        const current = queue.shift()!;

        if (direction === 'up') {
          // Walk parentRef (childOf)
          const entry = groups.get(current);
          if (entry?.parentRef && !seen.has(entry.parentRef)) {
            const parent = groups.get(entry.parentRef);
            if (parent) {
              seen.add(entry.parentRef);
              queue.push(entry.parentRef);
              visited.push({
                ref: parent.ref,
                kind: parent.kind,
                specType: parent.specType,
              });
            }
          }
        } else {
          // Walk children (parentOf)
          for (const [, g] of groups) {
            if (g.parentRef === current && !seen.has(g.ref)) {
              seen.add(g.ref);
              queue.push(g.ref);
              visited.push({
                ref: g.ref,
                kind: g.kind,
                specType: g.specType,
              });
            }
          }
        }
      }

      return visited;
    },

    async getGroupsByFilter(
      filter: GroupFilter,
    ): Promise<CatalogGroupSummary[]> {
      const results: CatalogGroupSummary[] = [];
      for (const [, g] of groups) {
        const kindMatch = g.kind.toLowerCase() === filter.kind.toLowerCase();
        const typeMatch =
          filter.specType === undefined || g.specType === filter.specType;
        if (kindMatch && typeMatch) {
          results.push({ ref: g.ref, kind: g.kind, specType: g.specType });
        }
      }
      return results;
    },

    async isUserMemberOfGroup(
      userRef: string,
      groupRef: string,
    ): Promise<boolean> {
      const group = groups.get(groupRef);
      if (!group) return false;
      return group.members.some(m => m.userRef === userRef);
    },

    async getManagerRef(userRef: string): Promise<string | undefined> {
      return users.get(userRef)?.managerRef;
    },

    async getUserJobTitle(userRef: string): Promise<string | undefined> {
      return users.get(userRef)?.jobTitle;
    },
  };

  return catalog;
}

/**
 * Pre-built org hierarchy used by the majority of escalation tests.
 *
 * Structure:
 * portfolio-consumer (Group:portfolio)
 * domain-search (Group:domain) → member: user:default/jane.director (Engineering Director)
 * team-a (Group:team) → member: user:default/alice
 * team-b (Group:team) → member: user:default/bob
 * domain-payments (Group:domain) → member: user:default/john.director (Engineering Director)
 * team-c (Group:team) → member: user:default/carol
 * portfolio-talent (Group:portfolio)
 * domain-talent (Group:domain) → member: user:default/vp.talent (VP Technology)
 * team-d (Group:team) → member: user:default/dave
 *
 * VP on portfolio-consumer: user:default/vp.consumer (VP Technology)
 * VP on portfolio-talent: user:default/vp.talent (VP Technology)
 *
 * fallbackActors group: group:default/platform-team
 * member: user:default/fallback.user
 */
export function createStandardOrgHierarchy(): MockCatalog {
  const catalog = createMockCatalog();

  // Portfolios
  catalog.addGroup('group:default/portfolio-consumer', {
    kind: 'Group',
    specType: 'portfolio',
  });
  catalog.addGroup('group:default/portfolio-talent', {
    kind: 'Group',
    specType: 'portfolio',
  });

  // Domains under consumer
  catalog.addGroup('group:default/domain-search', {
    kind: 'Group',
    specType: 'domain',
    parentRef: 'group:default/portfolio-consumer',
  });
  catalog.addGroup('group:default/domain-payments', {
    kind: 'Group',
    specType: 'domain',
    parentRef: 'group:default/portfolio-consumer',
  });

  // Domain under talent
  catalog.addGroup('group:default/domain-talent', {
    kind: 'Group',
    specType: 'domain',
    parentRef: 'group:default/portfolio-talent',
  });

  // Teams
  catalog.addGroup('group:default/team-a', {
    kind: 'Group',
    specType: 'team',
    parentRef: 'group:default/domain-search',
  });
  catalog.addGroup('group:default/team-b', {
    kind: 'Group',
    specType: 'team',
    parentRef: 'group:default/domain-search',
  });
  catalog.addGroup('group:default/team-c', {
    kind: 'Group',
    specType: 'team',
    parentRef: 'group:default/domain-payments',
  });
  catalog.addGroup('group:default/team-d', {
    kind: 'Group',
    specType: 'team',
    parentRef: 'group:default/domain-talent',
  });

  // Domain directors
  catalog.addUser(
    'user:default/jane.director',
    'Engineering Director, Search Platform',
    'group:default/domain-search',
  );
  catalog.addUser(
    'user:default/john.director',
    'Engineering Director, Payments Platform',
    'group:default/domain-payments',
  );
  catalog.addUser(
    'user:default/talent.director',
    'Engineering Director, Talent Platform',
    'group:default/domain-talent',
  );

  // Portfolio VPs
  catalog.addUser(
    'user:default/vp.consumer',
    'Vice President, Technology',
    'group:default/portfolio-consumer',
  );
  catalog.addUser(
    'user:default/vp.talent',
    'Vice President, Technology',
    'group:default/portfolio-talent',
  );

  // Team members
  catalog.addUser(
    'user:default/alice',
    'Software Engineer',
    'group:default/team-a',
  );
  catalog.addUser(
    'user:default/bob',
    'Software Engineer',
    'group:default/team-b',
  );
  catalog.addUser(
    'user:default/carol',
    'Software Engineer',
    'group:default/team-c',
  );
  catalog.addUser(
    'user:default/dave',
    'Software Engineer',
    'group:default/team-d',
  );

  // Fallback group
  catalog.addGroup('group:default/platform-team', {
    kind: 'Group',
    specType: 'team',
  });
  catalog.addUser(
    'user:default/fallback.user',
    'Platform Engineer',
    'group:default/platform-team',
  );

  return catalog;
}
