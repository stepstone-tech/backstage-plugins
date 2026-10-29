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
 * Unit tests for DefaultEscalationService.resolveAllActorsForGroup — the
 * multi-match variant of resolveActorForGroup. Covers both the
 * direct-member path and the manager-chain path. No DB required: the resolve
 * methods only touch `this.catalog` and `this.config`, so the store/scanner/
 * proposal-generator dependencies are inert stubs here.
 */

import { mockServices } from '@backstage/backend-test-utils';
import { DefaultEscalationService } from './EscalationService';
import {
  createMockCatalog,
  createStandardOrgHierarchy,
  MockCatalog,
} from './__fixtures__/createMockCatalog';
import {
  buildSingleLevelConfig,
  DOMAIN_LEVEL,
} from './__fixtures__/buildEscalationConfig';
import { EscalationConfig, EscalationLevelConfig } from '../config/types';

function buildService(catalog: MockCatalog, config: EscalationConfig) {
  const logger = mockServices.logger.mock();
  const store = {} as any;
  const mockScanner = { runScan: jest.fn(), scanEntity: jest.fn() } as any;
  const mockProposalGen = {
    generateProposalsForEntity: jest.fn().mockResolvedValue(0),
  } as any;
  return new DefaultEscalationService(
    store,
    catalog,
    config,
    { now: () => new Date('2026-01-01T00:00:00.000Z') } as any,
    mockScanner,
    mockProposalGen,
    logger,
  );
}

describe('DefaultEscalationService.resolveAllActorsForGroup', () => {
  describe('direct-member path', () => {
    it('returns the single Director member of a domain group', async () => {
      const catalog = createStandardOrgHierarchy();
      const svc = buildService(catalog, buildSingleLevelConfig(DOMAIN_LEVEL));

      const result = await svc.resolveAllActorsForGroup(
        'group:default/domain-search',
        1,
      );

      expect(result).toEqual(['user:default/jane.director']);
    });

    it('returns ALL matching members, deduped, when several match', async () => {
      const catalog = createMockCatalog();
      catalog.addGroup('group:default/domain-x', {
        kind: 'Group',
        specType: 'domain',
      });
      catalog.addUser(
        'user:default/dir.one',
        'Engineering Director, Alpha',
        'group:default/domain-x',
      );
      catalog.addUser(
        'user:default/dir.two',
        'Engineering Director, Beta',
        'group:default/domain-x',
      );
      catalog.addUser(
        'user:default/ic.one',
        'Software Engineer',
        'group:default/domain-x',
      );
      const svc = buildService(catalog, buildSingleLevelConfig(DOMAIN_LEVEL));

      const result = await svc.resolveAllActorsForGroup(
        'group:default/domain-x',
        1,
      );

      expect(result).toEqual(['user:default/dir.one', 'user:default/dir.two']);
    });

    it('returns [] when no member title matches', async () => {
      const catalog = createStandardOrgHierarchy();
      const svc = buildService(catalog, buildSingleLevelConfig(DOMAIN_LEVEL));

      // team-a has only an IC member (alice) — no Director.
      const result = await svc.resolveAllActorsForGroup(
        'group:default/team-a',
        1,
      );

      expect(result).toEqual([]);
    });

    it('returns [] for an out-of-range level', async () => {
      const catalog = createStandardOrgHierarchy();
      const svc = buildService(catalog, buildSingleLevelConfig(DOMAIN_LEVEL));

      expect(
        await svc.resolveAllActorsForGroup('group:default/domain-search', 5),
      ).toEqual([]);
    });
  });

  describe('manager-chain path', () => {
    const MANAGER_CHAIN_LEVEL: EscalationLevelConfig = {
      groupFilter: 'Group:domain',
      timeoutDays: 7,
      managerChain: true,
      titlePatterns: ['.*Director.*'],
    };

    it('walks each team member up to a matching manager and collects all', async () => {
      const catalog = createMockCatalog();
      catalog.addGroup('group:default/domain-y', {
        kind: 'Group',
        specType: 'domain',
      });
      catalog.addGroup('group:default/team-y', {
        kind: 'Group',
        specType: 'team',
        parentRef: 'group:default/domain-y',
      });
      // Two team members reporting to two different Directors.
      catalog.addUser(
        'user:default/eng.one',
        'Software Engineer',
        'group:default/team-y',
      );
      catalog.addUser(
        'user:default/eng.two',
        'Software Engineer',
        'group:default/team-y',
      );
      // addManager(userRef, managerRef, jobTitle) sets userRef's own title.
      catalog.addManager(
        'user:default/eng.one',
        'user:default/lead.one',
        'Software Engineer',
      );
      catalog.addManager(
        'user:default/lead.one',
        'user:default/dir.a',
        'Team Lead',
      );
      catalog.addManager(
        'user:default/dir.a',
        undefined,
        'Engineering Director',
      );
      catalog.addManager(
        'user:default/eng.two',
        'user:default/dir.b',
        'Software Engineer',
      );
      catalog.addManager(
        'user:default/dir.b',
        undefined,
        'Engineering Director',
      );

      const svc = buildService(
        catalog,
        buildSingleLevelConfig(MANAGER_CHAIN_LEVEL),
      );

      const result = await svc.resolveAllActorsForGroup(
        'group:default/domain-y',
        1,
        ['group:default/team-y'],
      );

      expect(result.sort()).toEqual([
        'user:default/dir.a',
        'user:default/dir.b',
      ]);
    });

    it('returns [] when the manager chain yields no matching title', async () => {
      const catalog = createMockCatalog();
      catalog.addGroup('group:default/domain-z', {
        kind: 'Group',
        specType: 'domain',
      });
      catalog.addGroup('group:default/team-z', {
        kind: 'Group',
        specType: 'team',
        parentRef: 'group:default/domain-z',
      });
      catalog.addUser(
        'user:default/eng.z',
        'Software Engineer',
        'group:default/team-z',
      );
      catalog.addManager(
        'user:default/eng.z',
        'user:default/lead.z',
        'Software Engineer',
      );
      catalog.addManager('user:default/lead.z', undefined, 'Team Lead');

      const svc = buildService(
        catalog,
        buildSingleLevelConfig(MANAGER_CHAIN_LEVEL),
      );

      const result = await svc.resolveAllActorsForGroup(
        'group:default/domain-z',
        1,
        ['group:default/team-z'],
      );

      expect(result).toEqual([]);
    });

    it('stops at the NEAREST matching manager per member (does not also collect higher matches)', async () => {
      const catalog = createMockCatalog();
      catalog.addGroup('group:default/domain-w', {
        kind: 'Group',
        specType: 'domain',
      });
      catalog.addGroup('group:default/team-w', {
        kind: 'Group',
        specType: 'team',
        parentRef: 'group:default/domain-w',
      });
      catalog.addUser(
        'user:default/eng.w',
        'Software Engineer',
        'group:default/team-w',
      );
      // Chain: eng.w → dir.w (Director) → vp.w (VP Director). Both titles match
      // the same '.*Director.*' pattern; only the nearest (dir.w) should be
      // collected — vp.w belongs to a higher escalation level.
      catalog.addManager(
        'user:default/eng.w',
        'user:default/dir.w',
        'Software Engineer',
      );
      catalog.addManager(
        'user:default/dir.w',
        'user:default/vp.w',
        'Engineering Director',
      );
      catalog.addManager(
        'user:default/vp.w',
        undefined,
        'VP, Director of Engineering',
      );

      const svc = buildService(
        catalog,
        buildSingleLevelConfig(MANAGER_CHAIN_LEVEL),
      );

      const result = await svc.resolveAllActorsForGroup(
        'group:default/domain-w',
        1,
        ['group:default/team-w'],
      );

      expect(result).toEqual(['user:default/dir.w']);
    });
  });
});
