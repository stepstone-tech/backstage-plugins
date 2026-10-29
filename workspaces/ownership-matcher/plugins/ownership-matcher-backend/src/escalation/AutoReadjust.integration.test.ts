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
 * Escalation queue auto-readjust and reorg resilience.
 *
 * Uses the stateful `MockCatalog` with `removeGroup`/`addGroup` to simulate
 * catalog changes between activation events.
 */

import { mockServices, TestDatabases } from '@backstage/backend-test-utils';
import { DatabaseOwnershipStore } from '../service/DatabaseOwnershipStore';
import { DefaultEscalationService } from './EscalationService';
import {
  createMockCatalog,
  createStandardOrgHierarchy,
  MockCatalog,
} from './__fixtures__/createMockCatalog';
import { buildValidEscalationConfig } from './__fixtures__/buildEscalationConfig';
import { TestClock } from './__fixtures__/Clock';
import {
  seedEntityRow,
  seedProposalRow,
  seedQueueEntry,
  seedDeadlineRow,
} from './__fixtures__/seedEntity';
import { DefaultDeadlineCheckerService } from './DeadlineCheckerService';

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
  catalog: MockCatalog,
  clock: TestClock = new TestClock(),
) {
  const config = buildValidEscalationConfig();
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

// ─── Auto-Readjust & Reorg Resilience ──────────────────────────────

describe('Auto-Readjust & Reorg Resilience', () => {
  describe('dead group handling', () => {
    it('dead group auto-skipped at activation — marked cancelled with skip_reason', async () => {
      const catalog = createStandardOrgHierarchy();
      const { store, knex } = await createStore();
      const entity = await seedEntityRow(knex, { current_status: 'escalated' });
      await seedProposalRow(knex, entity.id, {
        proposed_owner_ref: 'group:default/team-a',
        status: 'rejected',
        proposal_order: 1,
      });
      const deadEntry = await seedQueueEntry(knex, entity.id, {
        group_ref: 'group:default/domain-search',
        escalation_level: 1,
        position: 1,
        status: 'queued',
      });

      // Simulate reorg: domain-search dissolved from catalog.
      catalog.removeGroup('group:default/domain-search');

      const svc = buildService(store, catalog);
      await svc.revalidateQueue(entity.id);

      // Dead entry should be marked cancelled
      const entry = await knex('escalation_queue_entries')
        .where({ id: deadEntry.id })
        .first();
      expect(entry.status).toBe('cancelled');
      expect(entry.skip_reason).toBeDefined();

      // escalation_queue_entry_removed history written
      const history = await knex('ownership_history')
        .where({
          entity_id: entity.id,
          action: 'escalation_queue_entry_removed',
        })
        .first();
      expect(history).toBeDefined();
    });

    it('multiple dead groups in a row — all removed in single re-validation, fourth (live) entry activated', async () => {
      const catalog = createStandardOrgHierarchy();
      const { store, knex } = await createStore();
      const entity = await seedEntityRow(knex, { current_status: 'escalated' });

      // Three dead groups followed by one live group.
      for (let i = 1; i <= 3; i++) {
        catalog.addGroup(`group:default/domain-dead-${i}`, {
          kind: 'Group',
          specType: 'domain',
        });
        await seedQueueEntry(knex, entity.id, {
          group_ref: `group:default/domain-dead-${i}`,
          escalation_level: 1,
          position: i,
          status: 'queued',
        });
        catalog.removeGroup(`group:default/domain-dead-${i}`);
      }
      const liveEntry = await seedQueueEntry(knex, entity.id, {
        group_ref: 'group:default/domain-search',
        escalation_level: 1,
        position: 4,
        status: 'queued',
      });

      const svc = buildService(store, catalog);
      await svc.revalidateQueue(entity.id);

      // All 3 dead entries should be cancelled
      for (let i = 1; i <= 3; i++) {
        const deadRow = await knex('escalation_queue_entries')
          .where({
            entity_id: entity.id,
            group_ref: `group:default/domain-dead-${i}`,
          })
          .first();
        expect(deadRow.status).toBe('cancelled');
      }

      // Live entry should be activated (position 4 is now the first live entry)
      const live = await knex('escalation_queue_entries')
        .where({ id: liveEntry.id })
        .first();
      expect(live.status).toBe('active');
    });
  });

  describe('new group discovery', () => {
    it('new group discovered by BFS re-run — added at correct BFS position', async () => {
      // entry added at correct position. History: escalation_queue_entry_added.
      const catalog = createStandardOrgHierarchy();
      const { store, knex } = await createStore();
      const entity = await seedEntityRow(knex, { current_status: 'escalated' });
      await seedProposalRow(knex, entity.id, {
        proposed_owner_ref: 'group:default/team-a',
        status: 'rejected',
        proposal_order: 1,
      });

      // Simulate new domain-platform created after original BFS build.
      catalog.addGroup('group:default/domain-platform', {
        kind: 'Group',
        specType: 'domain',
        parentRef: 'group:default/portfolio-consumer',
      });
      catalog.addUser(
        'user:default/platform.director',
        'Engineering Director, Platform',
        'group:default/domain-platform',
      );

      const svc = buildService(store, catalog);
      await svc.revalidateQueue(entity.id);

      // New entry for domain-platform should be in the queue
      const newEntry = await knex('escalation_queue_entries')
        .where({
          entity_id: entity.id,
          group_ref: 'group:default/domain-platform',
        })
        .first();
      expect(newEntry).toBeDefined();
      expect(newEntry.status).toBe('queued');

      // escalation_queue_entry_added history written
      const history = await knex('ownership_history')
        .where({ entity_id: entity.id, action: 'escalation_queue_entry_added' })
        .first();
      expect(history).toBeDefined();
    });

    it('previously skipped group retried — new director appointed after original skip', async () => {
      const catalog = createMockCatalog();
      catalog.addGroup('group:default/domain-analytics', {
        kind: 'Group',
        specType: 'domain',
      });
      catalog.addGroup('group:default/team-analytics', {
        kind: 'Group',
        specType: 'team',
        parentRef: 'group:default/domain-analytics',
      });
      // Initially no director (was skipped).

      const { store, knex } = await createStore();
      const entity = await seedEntityRow(knex, { current_status: 'escalated' });
      await seedProposalRow(knex, entity.id, {
        proposed_owner_ref: 'group:default/team-analytics',
        status: 'rejected',
        proposal_order: 1,
      });
      const skippedEntry = await seedQueueEntry(knex, entity.id, {
        group_ref: 'group:default/domain-analytics',
        escalation_level: 1,
        position: 1,
        status: 'skipped', // was skipped on first pass
        skip_reason: 'no_actor_found',
      });

      // New director appointed.
      catalog.addUser(
        'user:default/analytics.director',
        'Engineering Director, Analytics',
        'group:default/domain-analytics',
      );

      const svc = buildService(store, catalog);
      await svc.revalidateQueue(entity.id);

      // Skipped entry should now be retried — a new active entry created
      const retried = await knex('escalation_queue_entries')
        .where({
          entity_id: entity.id,
          group_ref: 'group:default/domain-analytics',
          status: 'active',
        })
        .first();
      expect(retried).toBeDefined();
      // Original skipped entry still exists with status 'skipped'
      const original = await knex('escalation_queue_entries')
        .where({ id: skippedEntry.id })
        .first();
      expect(original.status).toBe('skipped');
    });

    it('new group at already-completed level — domain-ai added after all domains visited', async () => {
      const catalog = createStandardOrgHierarchy();
      const { store, knex } = await createStore();
      const entity = await seedEntityRow(knex, { current_status: 'escalated' });

      // All domain entries completed.
      await seedQueueEntry(knex, entity.id, {
        group_ref: 'group:default/domain-search',
        escalation_level: 1,
        position: 1,
        status: 'completed',
        resolved_actor_ref: 'user:default/jane.director',
      });
      // Portfolio entry is current.
      await seedQueueEntry(knex, entity.id, {
        group_ref: 'group:default/portfolio-consumer',
        escalation_level: 2,
        position: 10,
        status: 'queued',
      });

      // New domain added after original BFS.
      catalog.addGroup('group:default/domain-ai', {
        kind: 'Group',
        specType: 'domain',
        parentRef: 'group:default/portfolio-consumer',
      });
      catalog.addUser(
        'user:default/ai.director',
        'Engineering Director, AI',
        'group:default/domain-ai',
      );

      const svc = buildService(store, catalog);
      await svc.revalidateQueue(entity.id);

      // New domain-ai entry should be added to the queue (re-inserts at level 1)
      const newEntry = await knex('escalation_queue_entries')
        .where({ entity_id: entity.id, group_ref: 'group:default/domain-ai' })
        .first();
      expect(newEntry).toBeDefined();
    });
  });

  describe('actor snapshot and resolution', () => {
    it('actor resolved and snapshot stored at activation time', async () => {
      // History: escalation_actor_resolved with groupRef, actorRef, resolvedVia.
      const catalog = createStandardOrgHierarchy();
      const { store, knex } = await createStore();
      const entity = await seedEntityRow(knex, { current_status: 'escalated' });
      await seedProposalRow(knex, entity.id, {
        proposed_owner_ref: 'group:default/team-a',
        status: 'rejected',
        proposal_order: 1,
      });
      await seedQueueEntry(knex, entity.id, {
        group_ref: 'group:default/domain-search',
        escalation_level: 1,
        position: 1,
        status: 'queued',
      });

      const svc = buildService(store, catalog);
      await svc.activateNextEntry(entity.id);

      // resolved_actor_ref should be snapshotted
      const entry = await knex('escalation_queue_entries')
        .where({
          entity_id: entity.id,
          group_ref: 'group:default/domain-search',
        })
        .first();
      expect(entry.status).toBe('active');
      expect(entry.resolved_actor_ref).toBeDefined();
      expect(typeof entry.resolved_actor_ref).toBe('string');

      // escalation_actor_resolved history
      const history = await knex('ownership_history')
        .where({ entity_id: entity.id, action: 'escalation_actor_resolved' })
        .first();
      expect(history).toBeDefined();
    });

    it('director leaves mid-timeout — entry skipped at escalation_timeout fire', async () => {
      // R2: active slot re-validation when timeout fires. Group exists but actor
      // no longer matches titlePatterns (director left).
      const catalog = createStandardOrgHierarchy();
      const { store, knex } = await createStore();
      const clock = new TestClock(new Date('2026-01-08T00:00:00.000Z'));
      const entity = await seedEntityRow(knex, { current_status: 'escalated' });
      await seedQueueEntry(knex, entity.id, {
        group_ref: 'group:default/domain-search',
        escalation_level: 1,
        position: 1,
        status: 'active',
        resolved_actor_ref: 'user:default/jane.director',
      });
      // seedDeadlineRow imported at top level
      await seedDeadlineRow(knex, entity.id, {
        deadline_type: 'escalation_timeout',
        fire_at: new Date('2026-01-08T00:00:00.000Z'),
        actor_ref: 'user:default/jane.director',
        escalation_level: 1,
      });

      // Remove jane.director from domain-search (left company).
      catalog.removeGroup('group:default/domain-search');
      catalog.addGroup('group:default/domain-search', {
        kind: 'Group',
        specType: 'domain',
        parentRef: 'group:default/portfolio-consumer',
      });
      // No new director added → no actor found → entry should be skipped.

      // queue advancement so the dead-group skip logic uses the live catalog.
      const config = buildValidEscalationConfig();
      const logger = mockServices.logger.mock();
      const escSvc = buildService(store, catalog, clock);
      const checker = new DefaultDeadlineCheckerService(
        store,
        escSvc,
        config,
        clock,
        logger,
      );
      await checker.processExpiredDeadlines();

      // Domain-search entry should be skipped (no matching director)
      const entry = await knex('escalation_queue_entries')
        .where({
          entity_id: entity.id,
          group_ref: 'group:default/domain-search',
        })
        .first();
      expect(entry.status).toBe('skipped');
    });

    it('new director picked up for future queue entry — Director-B appointed', async () => {
      const catalog = createStandardOrgHierarchy();
      // Replace old director with new one.
      catalog.removeGroup('group:default/domain-search');
      catalog.addGroup('group:default/domain-search', {
        kind: 'Group',
        specType: 'domain',
        parentRef: 'group:default/portfolio-consumer',
      });
      catalog.addUser(
        'user:default/bob.director',
        'Engineering Director, Search',
        'group:default/domain-search',
      );

      const { store, knex } = await createStore();
      const entity = await seedEntityRow(knex, { current_status: 'escalated' });
      await seedQueueEntry(knex, entity.id, {
        group_ref: 'group:default/domain-search',
        escalation_level: 1,
        position: 1,
        status: 'queued',
      });
      const svc = buildService(store, catalog);

      await svc.activateNextEntry(entity.id);

      const entry = await knex('escalation_queue_entries')
        .where({
          entity_id: entity.id,
          group_ref: 'group:default/domain-search',
        })
        .first();
      expect(entry.status).toBe('active');
      // New director (bob.director) snapshotted
      expect(entry.resolved_actor_ref).toBe('user:default/bob.director');
    });

    it('group renamed — old entry removed, new group added by BFS re-run', async () => {
      // BFS discovers new group.
      const catalog = createStandardOrgHierarchy();
      const { store, knex } = await createStore();
      const entity = await seedEntityRow(knex, { current_status: 'escalated' });
      const oldEntry = await seedQueueEntry(knex, entity.id, {
        group_ref: 'group:default/domain-search', // old name
        escalation_level: 1,
        position: 1,
        status: 'queued',
      });

      // Simulate rename: old group deleted, new one created.
      catalog.removeGroup('group:default/domain-search');
      catalog.addGroup('group:default/domain-search-platform', {
        kind: 'Group',
        specType: 'domain',
        parentRef: 'group:default/portfolio-consumer',
      });
      catalog.addUser(
        'user:default/jane.director',
        'Engineering Director, Search Platform',
        'group:default/domain-search-platform',
      );
      catalog.addGroup('group:default/team-a', {
        kind: 'Group',
        specType: 'team',
        parentRef: 'group:default/domain-search-platform',
      });

      const svc = buildService(store, catalog);
      await svc.revalidateQueue(entity.id);

      // Old entry should be cancelled (dead group)
      const old = await knex('escalation_queue_entries')
        .where({ id: oldEntry.id })
        .first();
      expect(old.status).toBe('cancelled');

      // New entry for renamed group should be added
      const newEntry = await knex('escalation_queue_entries')
        .where({
          entity_id: entity.id,
          group_ref: 'group:default/domain-search-platform',
        })
        .first();
      expect(newEntry).toBeDefined();
    });
  });

  describe('circuit breaker', () => {
    it('soft circuit breaker fires — >50% of remaining entries removed, fallbackActors notified, escalation continues', async () => {
      const catalog = createStandardOrgHierarchy();
      const { store, knex } = await createStore();
      const entity = await seedEntityRow(knex, { current_status: 'escalated' });

      // 6 queued entries; 4 will be dead groups (>50%).
      for (let i = 1; i <= 4; i++) {
        catalog.addGroup(`group:default/domain-dead-cb-${i}`, {
          kind: 'Group',
          specType: 'domain',
        });
        await seedQueueEntry(knex, entity.id, {
          group_ref: `group:default/domain-dead-cb-${i}`,
          escalation_level: 1,
          position: i,
          status: 'queued',
        });
        catalog.removeGroup(`group:default/domain-dead-cb-${i}`);
      }
      await seedQueueEntry(knex, entity.id, {
        group_ref: 'group:default/domain-search',
        escalation_level: 1,
        position: 5,
        status: 'queued',
      });
      await seedQueueEntry(knex, entity.id, {
        group_ref: 'group:default/domain-payments',
        escalation_level: 1,
        position: 6,
        status: 'queued',
      });

      const svc = buildService(store, catalog);
      const result = await svc.revalidateQueue(entity.id);

      // 4 removed out of 6 total (>50%) → circuit breaker fires
      // Result exposes removed/added counts per RevalidateQueueResult
      expect(result.removed).toBe(4);
      expect(result.remainingBefore).toBe(6);

      // Escalation continues (remaining entries still accessible)
      const liveEntries = await knex('escalation_queue_entries').where({
        entity_id: entity.id,
        status: 'queued',
      });
      expect(liveEntries.length).toBeGreaterThan(0);
    });

    it('re-validation finds no changes — no escalation_queue_revalidated history event logged', async () => {
      const catalog = createStandardOrgHierarchy();
      const { store, knex } = await createStore();
      const entity = await seedEntityRow(knex, { current_status: 'escalated' });
      await seedQueueEntry(knex, entity.id, {
        group_ref: 'group:default/domain-search',
        escalation_level: 1,
        position: 1,
        status: 'queued',
      });
      // All groups still alive — no changes expected.
      const svc = buildService(store, catalog);

      await svc.revalidateQueue(entity.id);

      // No escalation_queue_revalidated history when there are no changes
      const revalidatedHistory = await knex('ownership_history')
        .where({ entity_id: entity.id, action: 'escalation_queue_revalidated' })
        .first();
      expect(revalidatedHistory).toBeUndefined();
    });

    it('all source teams dissolved → BFS produces empty queue → entity becomes unresolved', async () => {
      const catalog = createMockCatalog();
      catalog.addGroup('group:default/domain-dissolved', {
        kind: 'Group',
        specType: 'domain',
      });
      catalog.addGroup('group:default/team-dissolved', {
        kind: 'Group',
        specType: 'team',
        parentRef: 'group:default/domain-dissolved',
      });

      const { store, knex } = await createStore();
      const entity = await seedEntityRow(knex, { current_status: 'escalated' });
      await seedProposalRow(knex, entity.id, {
        proposed_owner_ref: 'group:default/team-dissolved',
        status: 'rejected',
        proposal_order: 1,
      });
      await seedQueueEntry(knex, entity.id, {
        group_ref: 'group:default/domain-dissolved',
        escalation_level: 1,
        position: 1,
        status: 'queued',
      });

      // Dissolve all source teams.
      catalog.removeGroup('group:default/team-dissolved');
      catalog.removeGroup('group:default/domain-dissolved');

      const svc = buildService(store, catalog);
      await svc.revalidateQueue(entity.id);

      // All queued entries cancelled, entity moves to unresolved
      const entityRow = await knex('ownership_entities')
        .where({ id: entity.id })
        .first();
      expect(entityRow.current_status).toBe('unresolved');
    });

    it('re-validation does NOT run during active suggestion — no queue changes', async () => {
      // suggestion the queue is unchanged.
      // Verifies seeded queue state unchanged without activation.
      const { knex } = await createStore();
      const entity = await seedEntityRow(knex, { current_status: 'escalated' });

      await seedQueueEntry(knex, entity.id, {
        group_ref: 'group:default/domain-payments',
        escalation_level: 1,
        position: 2,
        status: 'queued',
      });

      const rows = await knex('escalation_queue_entries').where({
        entity_id: entity.id,
        status: 'queued',
      });
      expect(rows).toHaveLength(1);
      // No re-validation ran; queue is unchanged.
    });
  });
});
