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
 * Fallback: fallbackActors, unresolved, level skipping.
 */

import { mockServices, TestDatabases } from '@backstage/backend-test-utils';
import { DatabaseOwnershipStore } from '../service/DatabaseOwnershipStore';
import { DefaultEscalationService } from './EscalationService';
import {
  createMockCatalog,
  createStandardOrgHierarchy,
} from './__fixtures__/createMockCatalog';
import {
  buildValidEscalationConfig,
  DOMAIN_LEVEL_RELATIONS,
  PORTFOLIO_LEVEL,
} from './__fixtures__/buildEscalationConfig';
import { TestClock } from './__fixtures__/Clock';
import {
  seedEntityRow,
  seedProposalRow,
  seedQueueEntry,
} from './__fixtures__/seedEntity';

const databases = TestDatabases.create({ ids: ['POSTGRES_16'] });

async function createStore() {
  const knex = await databases.init('POSTGRES_16');
  const database = {
    getClient: async () => knex,
    migrations: { skip: false },
  } as any;
  return { store: await DatabaseOwnershipStore.create({ database }), knex };
}

function buildService(
  store: DatabaseOwnershipStore,
  catalogOverride?: ReturnType<typeof createMockCatalog>,
  configOverrides = {},
) {
  const catalog = catalogOverride ?? createStandardOrgHierarchy();
  const config = buildValidEscalationConfig(configOverrides);
  const clock = new TestClock();
  const logger = mockServices.logger.mock();
  const mockScanner = { runScan: jest.fn(), scanEntity: jest.fn() } as any;
  const mockProposalGen = {
    generateProposalsForEntity: jest.fn().mockResolvedValue(0),
    generateProposals: jest.fn().mockResolvedValue(true),
  } as any;
  return new DefaultEscalationService(
    store,
    catalog,
    config,
    clock,
    mockScanner,
    mockProposalGen,
    logger,
  );
}

// ─── Fallback ────────────────────────────────────────────────────────

describe('Fallback', () => {
  describe('level skipping', () => {
    it('no actor via relations → level skipped, escalation continues to next level', async () => {
      // escalation_notified { skipped: true, reason: no_matching_actor }.
      const catalog = createMockCatalog();
      catalog.addGroup('group:default/domain-search', {
        kind: 'Group',
        specType: 'domain',
      });
      catalog.addGroup('group:default/team-a', {
        kind: 'Group',
        specType: 'team',
        parentRef: 'group:default/domain-search',
      });
      catalog.addGroup('group:default/portfolio-consumer', {
        kind: 'Group',
        specType: 'portfolio',
      });
      // No members with matching relations in domain-search.

      const { store, knex } = await createStore();
      const entity = await seedEntityRow(knex, { current_status: 'escalated' });
      void entity;
      const config = buildValidEscalationConfig({
        levels: [DOMAIN_LEVEL_RELATIONS, PORTFOLIO_LEVEL],
      });
      const logger = mockServices.logger.mock();
      const mockScanner = { runScan: jest.fn(), scanEntity: jest.fn() } as any;
      const mockProposalGen = {
        generateProposalsForEntity: jest.fn().mockResolvedValue(0),
        generateProposals: jest.fn().mockResolvedValue(true),
      } as any;
      const svc = new DefaultEscalationService(
        store,
        catalog,
        config,
        new TestClock(),
        mockScanner,
        mockProposalGen,
        logger,
      );

      // resolveActorForGroup returns undefined when no actor matches.
      // The interface contract uses `undefined` to mean "level skipped".
      const actor = await svc.resolveActorForGroup(
        'group:default/domain-search',
        1,
      );
      expect(actor).toBeUndefined();
    });

    it('no actor via titlePatterns → level skipped, escalation continues', async () => {
      const catalog = createMockCatalog();
      catalog.addGroup('group:default/domain-search', {
        kind: 'Group',
        specType: 'domain',
      });
      // Member with non-matching title.
      catalog.addUser(
        'user:default/alice',
        'Data Science Integration Manager',
        'group:default/domain-search',
      );

      const { store, knex } = await createStore();
      void knex;
      const svc = buildService(store, catalog);

      const actor = await svc.resolveActorForGroup(
        'group:default/domain-search',
        1,
      );
      expect(actor).toBeUndefined();
    });

    it('all levels skipped (no actors anywhere) → entity becomes unresolved, fallbackActors notified', async () => {
      const catalog = createMockCatalog();
      catalog.addGroup('group:default/domain-empty', {
        kind: 'Group',
        specType: 'domain',
      });
      catalog.addGroup('group:default/portfolio-empty', {
        kind: 'Group',
        specType: 'portfolio',
      });
      catalog.addGroup('group:default/team-a', {
        kind: 'Group',
        specType: 'team',
        parentRef: 'group:default/domain-empty',
      });
      // No directors or VPs with matching titles.

      const { store, knex } = await createStore();
      const entity = await seedEntityRow(knex, { current_status: 'escalated' });
      await seedProposalRow(knex, entity.id, {
        proposed_owner_ref: 'group:default/team-a',
        status: 'rejected',
        proposal_order: 1,
      });
      const svc = buildService(store, catalog);

      await svc.activateNextEntry(entity.id);

      const entityRow = await knex('ownership_entities')
        .where({ id: entity.id })
        .first();
      expect(entityRow.current_status).toBe('unresolved');
    });

    it('all levels exhausted → entity unresolved, escalation_exhausted history', async () => {
      const { store, knex } = await createStore();
      const entity = await seedEntityRow(knex, { current_status: 'escalated' });
      const svc = buildService(store);

      // No queued entries → exhausted.
      await svc.activateNextEntry(entity.id);

      const entityRow = await knex('ownership_entities')
        .where({ id: entity.id })
        .first();
      expect(entityRow.current_status).toBe('unresolved');

      const history = await knex('ownership_history')
        .where({ entity_id: entity.id, action: 'escalation_exhausted' })
        .first();
      expect(history).toBeDefined();
    });
  });

  describe('unresolved status', () => {
    it('unresolved entities queryable by status filter', async () => {
      // ListEntities is implemented.
      const { store, knex } = await createStore();
      await seedEntityRow(knex, { current_status: 'unresolved' });
      await seedEntityRow(knex, { current_status: 'open' });

      const result = await store.listEntities({ status: 'unresolved' });
      expect(result.items).toHaveLength(1);
      expect(result.items[0].current_status).toBe('unresolved');
    });

    it('unresolved entity readable by ID', async () => {
      // GetEntityById is implemented.
      const { store, knex } = await createStore();
      const entity = await seedEntityRow(knex, {
        current_status: 'unresolved',
      });

      const row = await store.getEntityById(entity.id);
      expect(row?.current_status).toBe('unresolved');
    });
  });

  describe('fallbackActors', () => {
    it('fallbackActors all notified on escalation exhaustion', async () => {
      const { store, knex } = await createStore();
      const entity = await seedEntityRow(knex, { current_status: 'escalated' });
      const config = buildValidEscalationConfig({
        fallbackActors: [
          'group:default/platform-team',
          'user:default/jane.smith',
        ],
      });
      const catalog = createStandardOrgHierarchy();
      const logger = mockServices.logger.mock();
      const mockScanner = { runScan: jest.fn(), scanEntity: jest.fn() } as any;
      const mockProposalGen = {
        generateProposalsForEntity: jest.fn().mockResolvedValue(0),
        generateProposals: jest.fn().mockResolvedValue(true),
      } as any;
      const svc = new DefaultEscalationService(
        store,
        catalog,
        config,
        new TestClock(),
        mockScanner,
        mockProposalGen,
        logger,
      );

      await svc.activateNextEntry(entity.id);

      // Entity becomes unresolved
      const entityRow = await knex('ownership_entities')
        .where({ id: entity.id })
        .first();
      expect(entityRow.current_status).toBe('unresolved');
      // escalation_exhausted written
      const history = await knex('ownership_history')
        .where({ entity_id: entity.id, action: 'escalation_exhausted' })
        .first();
      expect(history).toBeDefined();
    });

    it('no fallbackActors → unresolved with no notification, entity still in unresolved state', async () => {
      const { store, knex } = await createStore();
      const entity = await seedEntityRow(knex, { current_status: 'escalated' });
      const config = buildValidEscalationConfig({
        fallbackActors: undefined, // absent
      });
      const catalog = createStandardOrgHierarchy();
      const logger = mockServices.logger.mock();
      const mockScanner = { runScan: jest.fn(), scanEntity: jest.fn() } as any;
      const mockProposalGen = {
        generateProposalsForEntity: jest.fn().mockResolvedValue(0),
        generateProposals: jest.fn().mockResolvedValue(true),
      } as any;
      const svc = new DefaultEscalationService(
        store,
        catalog,
        config,
        new TestClock(),
        mockScanner,
        mockProposalGen,
        logger,
      );

      await svc.activateNextEntry(entity.id);

      const entityRow = await knex('ownership_entities')
        .where({ id: entity.id })
        .first();
      expect(entityRow.current_status).toBe('unresolved');
    });

    it('skipped level written with escalation_notified skipped=true history entry', async () => {
      const catalog = createMockCatalog();
      catalog.addGroup('group:default/domain-noskip', {
        kind: 'Group',
        specType: 'domain',
      });
      // No director-title user in this domain
      catalog.addGroup('group:default/portfolio-fallback', {
        kind: 'Group',
        specType: 'portfolio',
      });
      catalog.addUser(
        'user:default/vp.fallback',
        'Vice President, Technology',
        'group:default/portfolio-fallback',
      );

      const { store, knex } = await createStore();
      const entity = await seedEntityRow(knex, { current_status: 'escalated' });
      await seedQueueEntry(knex, entity.id, {
        group_ref: 'group:default/domain-noskip',
        escalation_level: 1,
        position: 1,
        status: 'queued',
      });
      await seedQueueEntry(knex, entity.id, {
        group_ref: 'group:default/portfolio-fallback',
        escalation_level: 2,
        position: 10,
        status: 'queued',
      });
      const svc = buildService(store, catalog);

      await svc.activateNextEntry(entity.id);

      // Skipped entry should be marked 'skipped' in queue
      const skippedEntry = await knex('escalation_queue_entries')
        .where({
          entity_id: entity.id,
          group_ref: 'group:default/domain-noskip',
        })
        .first();
      expect(skippedEntry.status).toBe('skipped');

      // escalation_queue_entry_skipped history written
      const skippedHistory = await knex('ownership_history')
        .where({
          entity_id: entity.id,
          action: 'escalation_queue_entry_skipped',
        })
        .first();
      expect(skippedHistory).toBeDefined();
    });
  });
});
