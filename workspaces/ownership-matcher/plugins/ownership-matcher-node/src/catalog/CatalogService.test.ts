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

import { CatalogApi } from '@backstage/catalog-client';
import { mockServices } from '@backstage/backend-test-utils';
import { CatalogService } from './CatalogService';
import { EntityFilters } from '../types';

function makeCatalogApi(pages: any[][]): CatalogApi {
  let callCount = 0;
  return {
    getEntities: jest.fn().mockResolvedValue({ items: [] }),
    queryEntities: jest.fn().mockImplementation(async () => {
      const items = pages[callCount] ?? [];
      callCount++;
      const hasNext = callCount < pages.length && pages[callCount]?.length > 0;
      return {
        items,
        pageInfo: hasNext ? { nextCursor: `cursor-${callCount}` } : {},
      };
    }),
    getEntityByRef: jest.fn(),
  } as unknown as CatalogApi;
}

const noFilters: EntityFilters = {
  excludeKinds: [],
  excludeNamespaces: [],
  excludeTypes: [],
  requireAnnotations: [],
  excludeOwners: [],
};

function entity(
  kind: string,
  name: string,
  ns = 'default',
  owner?: string,
  annotations?: Record<string, string>,
  type?: string,
) {
  return {
    kind,
    metadata: { name, namespace: ns, annotations },
    spec: { ...(owner ? { owner } : {}), ...(type ? { type } : {}) },
  };
}

describe('CatalogService', () => {
  const logger = mockServices.logger.mock();

  // ── getLiveGroupRegistry ───────────────────────────────────────────────────

  describe('getUserData', () => {
    it('requests metadata.annotations and maps name, annotations and memberOf', async () => {
      const api = makeCatalogApi([]);
      (api.getEntities as jest.Mock).mockResolvedValue({
        items: [
          {
            kind: 'User',
            metadata: {
              name: 'jane_doe',
              annotations: { 'example.com/sam-account-name': 'DoeJ01' },
            },
            spec: { memberOf: ['group:default/team-a'] },
          },
        ],
      });
      const svc = new CatalogService(api, logger);

      await expect(svc.getUserData()).resolves.toEqual([
        {
          kind: 'User',
          metadata: {
            name: 'jane_doe',
            annotations: { 'example.com/sam-account-name': 'DoeJ01' },
          },
          spec: { memberOf: ['group:default/team-a'] },
        },
      ]);
      expect(api.getEntities).toHaveBeenCalledWith(
        expect.objectContaining({
          filter: { kind: 'User' },
          fields: expect.arrayContaining([
            'metadata.annotations',
            'spec.memberOf',
          ]),
        }),
      );
    });

    it('maps spec.profile.email when present', async () => {
      const api = makeCatalogApi([]);
      (api.getEntities as jest.Mock).mockResolvedValue({
        items: [
          {
            kind: 'User',
            metadata: { name: 'jane' },
            spec: {
              memberOf: ['group:default/team-a'],
              profile: { email: 'jane@example.com', displayName: 'Jane' },
            },
          },
        ],
      });
      const svc = new CatalogService(api, logger);

      await expect(svc.getUserData()).resolves.toEqual([
        {
          kind: 'User',
          metadata: { name: 'jane', annotations: undefined },
          spec: {
            memberOf: ['group:default/team-a'],
            profile: { email: 'jane@example.com' },
          },
        },
      ]);
      expect(api.getEntities).toHaveBeenCalledWith(
        expect.objectContaining({
          fields: expect.arrayContaining(['spec.profile.email']),
        }),
      );
    });
  });

  describe('getEntityByRef', () => {
    it('maps spec.type', async () => {
      const api = makeCatalogApi([]);
      (api.getEntityByRef as jest.Mock).mockResolvedValue(
        entity(
          'Resource',
          'acct',
          'default',
          undefined,
          undefined,
          'cloud-account',
        ),
      );
      const svc = new CatalogService(api, logger);

      const result = await svc.getEntityByRef('resource:default/acct');
      expect(result?.spec?.type).toBe('cloud-account');
    });
  });

  describe('getLiveGroupRegistry', () => {
    it('returns group refs as set', async () => {
      const api = {
        getEntities: jest.fn().mockResolvedValue({
          items: [
            {
              kind: 'Group',
              metadata: { name: 'team-a', namespace: 'default' },
            },
            {
              kind: 'Group',
              metadata: { name: 'team-b', namespace: 'default' },
            },
          ],
        }),
      } as unknown as CatalogApi;

      const svc = new CatalogService(api, logger);
      const registry = await svc.getLiveGroupRegistry();

      expect(registry.has('group:default/team-a')).toBe(true);
      expect(registry.has('group:default/team-b')).toBe(true);
      expect(registry.size).toBe(2);
    });

    it('caches result — catalog only called once', async () => {
      const api = {
        getEntities: jest.fn().mockResolvedValue({ items: [] }),
      } as unknown as CatalogApi;

      const svc = new CatalogService(api, logger);
      await svc.getLiveGroupRegistry();
      await svc.getLiveGroupRegistry();

      expect(api.getEntities).toHaveBeenCalledTimes(1);
    });

    it('returns empty set on catalog error', async () => {
      const api = {
        getEntities: jest.fn().mockRejectedValue(new Error('timeout')),
      } as unknown as CatalogApi;

      const svc = new CatalogService(api, logger);
      const registry = await svc.getLiveGroupRegistry();
      expect(registry.size).toBe(0);
    });

    it('resets cache after resetCache()', async () => {
      const api = {
        getEntities: jest.fn().mockResolvedValue({ items: [] }),
      } as unknown as CatalogApi;

      const svc = new CatalogService(api, logger);
      await svc.getLiveGroupRegistry();
      svc.resetCache();
      await svc.getLiveGroupRegistry();

      expect(api.getEntities).toHaveBeenCalledTimes(2);
    });
  });

  describe('getLiveUserRegistry', () => {
    it('returns user refs as set, defaulting namespace', async () => {
      const api = {
        getEntities: jest.fn().mockResolvedValue({
          items: [
            { kind: 'User', metadata: { name: 'jdoe', namespace: 'default' } },
            { kind: 'User', metadata: { name: 'asmith' } },
            { kind: 'User', metadata: { name: 'John.Doe', namespace: 'Corp' } },
          ],
        }),
      } as unknown as CatalogApi;

      const svc = new CatalogService(api, logger);
      const registry = await svc.getLiveUserRegistry();

      expect(registry).toEqual(
        new Set([
          'user:default/jdoe',
          'user:default/asmith',
          'user:corp/john.doe',
        ]),
      );
      expect(api.getEntities).toHaveBeenCalledWith(
        expect.objectContaining({ filter: { kind: 'User' } }),
      );
    });

    it('caches result until resetCache()', async () => {
      const api = {
        getEntities: jest.fn().mockResolvedValue({ items: [] }),
      } as unknown as CatalogApi;

      const svc = new CatalogService(api, logger);
      await svc.getLiveUserRegistry();
      await svc.getLiveUserRegistry();
      expect(api.getEntities).toHaveBeenCalledTimes(1);

      svc.resetCache();
      await svc.getLiveUserRegistry();
      expect(api.getEntities).toHaveBeenCalledTimes(2);
    });

    it('rethrows catalog errors instead of returning an empty set', async () => {
      const api = {
        getEntities: jest.fn().mockRejectedValue(new Error('timeout')),
      } as unknown as CatalogApi;

      const svc = new CatalogService(api, logger);
      await expect(svc.getLiveUserRegistry()).rejects.toThrow('timeout');
    });
  });

  // ── paginateEntities ───────────────────────────────────────────────────────

  describe('paginateEntities', () => {
    it('yields entities from a single page', async () => {
      const api = makeCatalogApi([[entity('Component', 'svc')]]);
      const svc = new CatalogService(api, logger);

      const results: any[] = [];
      for await (const e of svc.paginateEntities(noFilters)) results.push(e);

      expect(results).toHaveLength(1);
      expect(results[0].metadata.name).toBe('svc');
    });

    it('paginates across multiple pages', async () => {
      // Simulate 3 pages: 500, 500, 100 items
      const page1 = Array.from({ length: 500 }, (_, i) =>
        entity('Component', `svc-${i}`),
      );
      const page2 = Array.from({ length: 500 }, (_, i) =>
        entity('Component', `svc-${500 + i}`),
      );
      const page3 = Array.from({ length: 100 }, (_, i) =>
        entity('Component', `svc-${1000 + i}`),
      );

      const api = makeCatalogApi([page1, page2, page3]);
      const svc = new CatalogService(api, logger);

      const results: any[] = [];
      for await (const e of svc.paginateEntities(noFilters)) results.push(e);

      expect(results).toHaveLength(1100);
    });

    it('excludes kinds from excludeKinds filter', async () => {
      const api = makeCatalogApi([
        [
          entity('Component', 'svc'),
          entity('API', 'api-1'),
          entity('Resource', 'res-1'),
        ],
      ]);
      const svc = new CatalogService(api, logger);

      const results: any[] = [];
      for await (const e of svc.paginateEntities({
        ...noFilters,
        excludeKinds: ['API', 'Resource'],
      })) {
        results.push(e);
      }

      expect(results).toHaveLength(1);
      expect(results[0].kind).toBe('Component');
    });

    it('excludes entities matching excludeTypes (kind:type, case-insensitive) and keeps other types', async () => {
      const api = makeCatalogApi([
        [
          entity(
            'Resource',
            'acct-1',
            'default',
            undefined,
            undefined,
            'cloud-account',
          ),
          entity(
            'Resource',
            'db-1',
            'default',
            undefined,
            undefined,
            'database',
          ),
          entity(
            'Component',
            'svc',
            'default',
            undefined,
            undefined,
            'cloud-account',
          ),
          entity('Resource', 'untyped'),
        ],
      ]);
      const svc = new CatalogService(api, logger);

      const results: any[] = [];
      for await (const e of svc.paginateEntities({
        ...noFilters,
        excludeTypes: ['resource:Cloud-Account'],
      })) {
        results.push(e);
      }

      expect(results.map(e => e.metadata.name)).toEqual([
        'db-1',
        'svc',
        'untyped',
      ]);
      expect(results[0].spec.type).toBe('database');
    });

    it('excludes namespaces from excludeNamespaces filter', async () => {
      const api = makeCatalogApi([
        [
          entity('Component', 'svc', 'default'),
          entity('Component', 'internal-svc', 'internal'),
        ],
      ]);
      const svc = new CatalogService(api, logger);

      const results: any[] = [];
      for await (const e of svc.paginateEntities({
        ...noFilters,
        excludeNamespaces: ['internal'],
      })) {
        results.push(e);
      }

      expect(results).toHaveLength(1);
      expect(results[0].metadata.namespace).toBe('default');
    });

    it('filters by requireAnnotations — all required annotations must be present', async () => {
      const api = makeCatalogApi([
        [
          entity('Component', 'annotated', 'default', undefined, {
            'backstage.io/managed-by-location': 'url:...',
          }),
          entity('Component', 'plain'),
        ],
      ]);
      const svc = new CatalogService(api, logger);

      const results: any[] = [];
      for await (const e of svc.paginateEntities({
        ...noFilters,
        requireAnnotations: ['backstage.io/managed-by-location'],
      })) {
        results.push(e);
      }

      expect(results).toHaveLength(1);
      expect(results[0].metadata.name).toBe('annotated');
    });

    it('excludes entities by owner ref', async () => {
      const api = makeCatalogApi([
        [
          entity('Component', 'svc', 'default', 'group:default/platform'),
          entity('Component', 'other-svc', 'default', 'group:default/team-a'),
        ],
      ]);
      const svc = new CatalogService(api, logger);

      const results: any[] = [];
      for await (const e of svc.paginateEntities({
        ...noFilters,
        excludeOwners: ['group:default/platform'],
      })) {
        results.push(e);
      }

      expect(results).toHaveLength(1);
      expect(results[0].metadata.name).toBe('other-svc');
    });

    it('maps spec.lifecycle onto the yielded component', async () => {
      const api = makeCatalogApi([
        [
          {
            kind: 'Component',
            metadata: { name: 'svc', namespace: 'default' },
            spec: { lifecycle: 'production' },
          },
        ],
      ]);
      const svc = new CatalogService(api, logger);

      const results: any[] = [];
      for await (const e of svc.paginateEntities(noFilters)) results.push(e);

      expect(results[0].spec?.lifecycle).toBe('production');
    });

    it('returns empty when catalog errors mid-iteration', async () => {
      const api = {
        queryEntities: jest.fn().mockRejectedValue(new Error('network error')),
      } as unknown as CatalogApi;

      const svc = new CatalogService(api, logger);

      const results: any[] = [];
      for await (const e of svc.paginateEntities(noFilters)) results.push(e);

      expect(results).toHaveLength(0);
    });
  });

  // ── getGroupMembersWithTitles ─────────────────────────────────────────────

  describe('getGroupMembersWithTitles', () => {
    it('returns userRef + jobTitle from metadata.userDetails (directory-sync shape)', async () => {
      const api = {
        getEntityByRef: jest.fn().mockResolvedValue({
          kind: 'Group',
          metadata: { name: 'team-a', namespace: 'default' },
          relations: [
            { type: 'hasMember', targetRef: 'user:default/alice' },
            { type: 'hasMember', targetRef: 'user:default/bob' },
          ],
        }),
        getEntitiesByRefs: jest.fn().mockResolvedValue({
          items: [
            {
              kind: 'User',
              metadata: {
                name: 'alice',
                namespace: 'default',
                userDetails: { jobTitle: 'Engineering Director' },
              },
            },
            {
              kind: 'User',
              metadata: { name: 'bob', namespace: 'default' },
              spec: { profile: { title: 'Senior Engineer' } },
            },
          ],
        }),
      } as unknown as CatalogApi;
      const svc = new CatalogService(api, logger);

      const result = await svc.getGroupMembersWithTitles(
        'group:default/team-a',
      );

      expect(result).toEqual([
        { userRef: 'user:default/alice', jobTitle: 'Engineering Director' },
        { userRef: 'user:default/bob', jobTitle: 'Senior Engineer' },
      ]);
    });

    it('returns [] when group has no members', async () => {
      const api = {
        getEntityByRef: jest.fn().mockResolvedValue({
          kind: 'Group',
          metadata: { name: 'team-a', namespace: 'default' },
          relations: [],
        }),
      } as unknown as CatalogApi;
      const svc = new CatalogService(api, logger);

      const result = await svc.getGroupMembersWithTitles(
        'group:default/team-a',
      );
      expect(result).toEqual([]);
    });

    it('returns [] on catalog error (graceful degradation)', async () => {
      const api = {
        getEntityByRef: jest.fn().mockRejectedValue(new Error('catalog 503')),
      } as unknown as CatalogApi;
      const svc = new CatalogService(api, logger);

      const result = await svc.getGroupMembersWithTitles(
        'group:default/team-a',
      );
      expect(result).toEqual([]);
    });

    it('preserves member order; missing jobTitle becomes undefined, not dropped', async () => {
      const api = {
        getEntityByRef: jest.fn().mockResolvedValue({
          kind: 'Group',
          metadata: { name: 'team-a', namespace: 'default' },
          relations: [
            { type: 'hasMember', targetRef: 'user:default/alice' },
            { type: 'hasMember', targetRef: 'user:default/bob' },
          ],
        }),
        getEntitiesByRefs: jest.fn().mockResolvedValue({
          items: [
            { kind: 'User', metadata: { name: 'alice', namespace: 'default' } },
            {
              kind: 'User',
              metadata: {
                name: 'bob',
                namespace: 'default',
                userDetails: { jobTitle: 'VP' },
              },
            },
          ],
        }),
      } as unknown as CatalogApi;
      const svc = new CatalogService(api, logger);

      const result = await svc.getGroupMembersWithTitles(
        'group:default/team-a',
      );
      expect(result).toEqual([
        { userRef: 'user:default/alice', jobTitle: undefined },
        { userRef: 'user:default/bob', jobTitle: 'VP' },
      ]);
    });
  });

  // ── walkGroupHierarchy ────────────────────────────────────────────────────

  describe('walkGroupHierarchy', () => {
    function buildHierarchy() {
      // team-a → domain-search → portfolio-consumer
      return {
        'group:default/team-a': {
          kind: 'Group',
          metadata: { name: 'team-a', namespace: 'default' },
          spec: { type: 'team' },
          relations: [
            { type: 'childOf', targetRef: 'group:default/domain-search' },
          ],
        },
        'group:default/domain-search': {
          kind: 'Group',
          metadata: { name: 'domain-search', namespace: 'default' },
          spec: { type: 'domain' },
          relations: [
            { type: 'childOf', targetRef: 'group:default/portfolio-consumer' },
            { type: 'parentOf', targetRef: 'group:default/team-a' },
          ],
        },
        'group:default/portfolio-consumer': {
          kind: 'Group',
          metadata: { name: 'portfolio-consumer', namespace: 'default' },
          spec: { type: 'portfolio' },
          relations: [
            { type: 'parentOf', targetRef: 'group:default/domain-search' },
          ],
        },
      } as Record<string, any>;
    }

    function makeApi(byRef: Record<string, any>): CatalogApi {
      return {
        getEntitiesByRefs: jest
          .fn()
          .mockImplementation(
            async ({ entityRefs }: { entityRefs: string[] }) => ({
              items: entityRefs.map(r => byRef[r] ?? null),
            }),
          ),
      } as unknown as CatalogApi;
    }

    it('walks `up` (childOf) — returns ancestors excluding the start ref', async () => {
      const svc = new CatalogService(makeApi(buildHierarchy()), logger);
      const result = await svc.walkGroupHierarchy('group:default/team-a', 'up');
      expect(result.map(g => g.ref)).toEqual([
        'group:default/domain-search',
        'group:default/portfolio-consumer',
      ]);
      expect(result[0].specType).toBe('domain');
      expect(result[1].specType).toBe('portfolio');
    });

    it('walks `down` (parentOf) — returns descendants excluding the start ref', async () => {
      const svc = new CatalogService(makeApi(buildHierarchy()), logger);
      const result = await svc.walkGroupHierarchy(
        'group:default/portfolio-consumer',
        'down',
      );
      expect(result.map(g => g.ref)).toEqual([
        'group:default/domain-search',
        'group:default/team-a',
      ]);
    });

    it('handles missing entities gracefully', async () => {
      const svc = new CatalogService(makeApi({}), logger);
      const result = await svc.walkGroupHierarchy(
        'group:default/missing',
        'up',
      );
      expect(result).toEqual([]);
    });

    it('does not loop on circular relations', async () => {
      const cycle: Record<string, any> = {
        'group:default/a': {
          kind: 'Group',
          metadata: { name: 'a', namespace: 'default' },
          relations: [{ type: 'childOf', targetRef: 'group:default/b' }],
        },
        'group:default/b': {
          kind: 'Group',
          metadata: { name: 'b', namespace: 'default' },
          relations: [{ type: 'childOf', targetRef: 'group:default/a' }],
        },
      };
      const svc = new CatalogService(makeApi(cycle), logger);
      const result = await svc.walkGroupHierarchy('group:default/a', 'up');
      expect(result.map(g => g.ref)).toEqual(['group:default/b']);
    });

    it('returns [] on catalog error', async () => {
      const api = {
        getEntitiesByRefs: jest
          .fn()
          .mockRejectedValue(new Error('catalog 503')),
      } as unknown as CatalogApi;
      const svc = new CatalogService(api, logger);
      const result = await svc.walkGroupHierarchy('group:default/a', 'up');
      expect(result).toEqual([]);
    });

    it('handles diamond pattern (A→B,A→C,B→D,C→D) without duplicating D', async () => {
      // Walk `up` from D — both B and C have childOf relations to a shared
      // grandparent. visited-set must prevent D's grandparent from
      // being enqueued twice.
      const diamond: Record<string, any> = {
        'group:default/d': {
          kind: 'Group',
          metadata: { name: 'd', namespace: 'default' },
          relations: [
            { type: 'childOf', targetRef: 'group:default/b' },
            { type: 'childOf', targetRef: 'group:default/c' },
          ],
        },
        'group:default/b': {
          kind: 'Group',
          metadata: { name: 'b', namespace: 'default' },
          relations: [{ type: 'childOf', targetRef: 'group:default/a' }],
        },
        'group:default/c': {
          kind: 'Group',
          metadata: { name: 'c', namespace: 'default' },
          relations: [{ type: 'childOf', targetRef: 'group:default/a' }],
        },
        'group:default/a': {
          kind: 'Group',
          metadata: { name: 'a', namespace: 'default' },
          relations: [],
        },
      };
      const svc = new CatalogService(makeApi(diamond), logger);
      const result = await svc.walkGroupHierarchy('group:default/d', 'up');
      const refs = result.map(g => g.ref);
      // A appears exactly once; B and C both at level 1.
      expect(refs.sort()).toEqual([
        'group:default/a',
        'group:default/b',
        'group:default/c',
      ]);
    });

    it('filters non-Group entities mid-chain so only Group results emit', async () => {
      const tree: Record<string, any> = {
        'group:default/team-a': {
          kind: 'Group',
          metadata: { name: 'team-a', namespace: 'default' },
          relations: [{ type: 'childOf', targetRef: 'system:default/billing' }],
        },
        'system:default/billing': {
          kind: 'System',
          metadata: { name: 'billing', namespace: 'default' },
          relations: [
            { type: 'childOf', targetRef: 'group:default/portfolio' },
          ],
        },
        'group:default/portfolio': {
          kind: 'Group',
          metadata: { name: 'portfolio', namespace: 'default' },
          relations: [],
        },
      };
      const svc = new CatalogService(makeApi(tree), logger);
      const result = await svc.walkGroupHierarchy('group:default/team-a', 'up');
      // The System entity is skipped from results but its relations are
      // still followed; portfolio is reached transitively.
      expect(result.map(g => g.ref)).toEqual(['group:default/portfolio']);
    });

    it('caches walk result per (startRef, direction) — second call hits zero catalog reads', async () => {
      const api = makeApi(buildHierarchy());
      const svc = new CatalogService(api, logger);

      await svc.walkGroupHierarchy('group:default/team-a', 'up');
      const firstCount = (api.getEntitiesByRefs as jest.Mock).mock.calls.length;

      await svc.walkGroupHierarchy('group:default/team-a', 'up');
      const secondCount = (api.getEntitiesByRefs as jest.Mock).mock.calls
        .length;

      expect(secondCount).toBe(firstCount);
    });

    it('makes one catalog call per BFS level (not two) — confirms double-fetch is gone', async () => {
      const api = makeApi(buildHierarchy());
      const svc = new CatalogService(api, logger);

      await svc.walkGroupHierarchy('group:default/team-a', 'up');

      // Hierarchy is team → domain → portfolio: 3 levels visited.
      // Pre-fix the impl made 2 calls per level (= 6); the fix is 1 per
      // level until the frontier empties (= 3, plus one terminal call
      // that returns no new refs to enqueue).
      const calls = (api.getEntitiesByRefs as jest.Mock).mock.calls.length;
      expect(calls).toBeLessThanOrEqual(3);
    });
  });

  // ── getGroupsByFilter ─────────────────────────────────────────────────────

  describe('getGroupsByFilter', () => {
    it('queries with kind only when specType is undefined', async () => {
      const api = {
        queryEntities: jest.fn().mockResolvedValue({
          items: [
            {
              kind: 'Group',
              metadata: { name: 'team-a', namespace: 'default' },
              spec: { type: 'team' },
            },
          ],
          pageInfo: {},
        }),
      } as unknown as CatalogApi;
      const svc = new CatalogService(api, logger);

      const result = await svc.getGroupsByFilter({
        kind: 'Group',
        specType: undefined,
      });

      expect(api.queryEntities).toHaveBeenCalledWith(
        expect.objectContaining({
          filter: { kind: 'Group' },
        }),
      );
      expect(result).toEqual([
        { ref: 'group:default/team-a', kind: 'Group', specType: 'team' },
      ]);
    });

    it('adds spec.type filter when specType provided', async () => {
      const api = {
        queryEntities: jest.fn().mockResolvedValue({
          items: [
            {
              kind: 'Group',
              metadata: { name: 'domain-search', namespace: 'default' },
              spec: { type: 'domain' },
            },
          ],
          pageInfo: {},
        }),
      } as unknown as CatalogApi;
      const svc = new CatalogService(api, logger);

      await svc.getGroupsByFilter({ kind: 'Group', specType: 'domain' });

      expect(api.queryEntities).toHaveBeenCalledWith(
        expect.objectContaining({
          filter: { kind: 'Group', 'spec.type': 'domain' },
        }),
      );
    });

    it('paginates via nextCursor — returns the union across pages', async () => {
      // Real catalogs may have > QUERY_LIMIT groups for a kind. Without
      // pagination this method would silently truncate and the BFS
      // revalidation path would miss tail teams.
      const api = {
        queryEntities: jest
          .fn()
          .mockResolvedValueOnce({
            items: [
              {
                kind: 'Group',
                metadata: { name: 'team-a', namespace: 'default' },
                spec: { type: 'team' },
              },
              {
                kind: 'Group',
                metadata: { name: 'team-b', namespace: 'default' },
                spec: { type: 'team' },
              },
            ],
            pageInfo: { nextCursor: 'cursor-1' },
          })
          .mockResolvedValueOnce({
            items: [
              {
                kind: 'Group',
                metadata: { name: 'team-c', namespace: 'default' },
                spec: { type: 'team' },
              },
            ],
            pageInfo: {},
          }),
      } as unknown as CatalogApi;
      const svc = new CatalogService(api, logger);

      const result = await svc.getGroupsByFilter({
        kind: 'Group',
        specType: 'team',
      });

      expect(api.queryEntities).toHaveBeenCalledTimes(2);
      expect(result.map(g => g.ref)).toEqual([
        'group:default/team-a',
        'group:default/team-b',
        'group:default/team-c',
      ]);
    });

    it('returns [] for empty result set', async () => {
      const api = {
        queryEntities: jest.fn().mockResolvedValue({ items: [], pageInfo: {} }),
      } as unknown as CatalogApi;
      const svc = new CatalogService(api, logger);

      const result = await svc.getGroupsByFilter({
        kind: 'Group',
        specType: 'nonexistent',
      });
      expect(result).toEqual([]);
    });

    it('returns [] on catalog error', async () => {
      const api = {
        queryEntities: jest.fn().mockRejectedValue(new Error('catalog 503')),
      } as unknown as CatalogApi;
      const svc = new CatalogService(api, logger);

      const result = await svc.getGroupsByFilter({
        kind: 'Group',
        specType: undefined,
      });
      expect(result).toEqual([]);
    });
  });

  // ── catalog conventions ───────────────────────────────────────────────────

  describe('catalog conventions', () => {
    const conventions = {
      userAliasAnnotation: 'example.com/alias',
      managerAnnotation: 'example.com/manager-alias',
      teamGroupTypes: ['team', 'squad'],
    };

    it('getTeamGroupRegistry filters on the default team type', async () => {
      const api = makeCatalogApi([]);
      await new CatalogService(api, logger).getTeamGroupRegistry();
      expect(api.getEntities).toHaveBeenCalledWith(
        expect.objectContaining({
          filter: { kind: 'Group', 'spec.type': ['team'] },
        }),
      );
    });

    it('getTeamGroupRegistry filters on the configured team types', async () => {
      const api = makeCatalogApi([]);
      await new CatalogService(api, logger, conventions).getTeamGroupRegistry();
      expect(api.getEntities).toHaveBeenCalledWith(
        expect.objectContaining({
          filter: { kind: 'Group', 'spec.type': ['team', 'squad'] },
        }),
      );
    });

    it('getAllUserDetails reads alias from the configured annotation', async () => {
      const api = makeCatalogApi([]);
      (api.getEntities as jest.Mock).mockResolvedValue({
        items: [
          {
            kind: 'User',
            metadata: {
              name: 'jane',
              annotations: { 'example.com/alias': 'jdoe' },
            },
          },
        ],
      });

      await expect(
        new CatalogService(api, logger, conventions).getAllUserDetails(),
      ).resolves.toEqual([
        {
          userRef: 'user:default/jane',
          jobTitle: undefined,
          alias: 'jdoe',
          email: undefined,
        },
      ]);
      await expect(
        new CatalogService(api, logger).getAllUserDetails(),
      ).resolves.toEqual([
        {
          userRef: 'user:default/jane',
          jobTitle: undefined,
          alias: undefined,
          email: undefined,
        },
      ]);
    });

    it('getManagerRef resolves the manager through the configured annotations', async () => {
      const api = makeCatalogApi([]);
      (api.getEntityByRef as jest.Mock).mockResolvedValue({
        kind: 'User',
        metadata: {
          name: 'jane',
          annotations: { 'example.com/manager-alias': 'bboss' },
        },
      });
      (api.getEntities as jest.Mock).mockResolvedValue({
        items: [
          { kind: 'User', metadata: { name: 'bob', namespace: 'default' } },
        ],
      });

      await expect(
        new CatalogService(api, logger, conventions).getManagerRef(
          'user:default/jane',
        ),
      ).resolves.toBe('user:default/bob');
      expect(api.getEntities).toHaveBeenCalledWith(
        expect.objectContaining({
          filter: {
            kind: 'User',
            'metadata.annotations.example.com/alias': 'bboss',
          },
        }),
      );
    });

    it.each([
      ['no annotations configured', { teamGroupTypes: ['team'] }],
      [
        'only manager configured',
        {
          managerAnnotation: 'example.com/manager-alias',
          teamGroupTypes: ['team'],
        },
      ],
    ])(
      'getManagerRef returns undefined without catalog calls when %s',
      async (_, c) => {
        const api = makeCatalogApi([]);
        await expect(
          new CatalogService(api, logger, c).getManagerRef('user:default/jane'),
        ).resolves.toBeUndefined();
        expect(api.getEntityByRef).not.toHaveBeenCalled();
        expect(api.getEntities).not.toHaveBeenCalled();
      },
    );
  });
});
