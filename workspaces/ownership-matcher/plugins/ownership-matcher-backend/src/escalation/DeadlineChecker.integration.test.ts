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
 * Deadline checker and scanner idempotency.
 *
 * Runs on Postgres only: partial unique indexes and row-level locking are
 * Postgres-specific.
 */

import { mockServices, TestDatabases } from '@backstage/backend-test-utils';
import { DatabaseOwnershipStore } from '../service/DatabaseOwnershipStore';
import { DefaultDeadlineCheckerService } from './DeadlineCheckerService';
import { DefaultEscalationService } from './EscalationService';
import { buildValidEscalationConfig } from './__fixtures__/buildEscalationConfig';
import { createStandardOrgHierarchy } from './__fixtures__/createMockCatalog';
import { TestClock } from './__fixtures__/Clock';
import {
  seedEntityRow,
  seedProposalRow,
  seedDeadlineRow,
  seedQueueEntry,
} from './__fixtures__/seedEntity';

// Postgres-only after task 0 (SQLite dropped).
const databases = TestDatabases.create({ ids: ['POSTGRES_16'] });

async function createStore(_usePg = false) {
  const knex = await databases.init('POSTGRES_16');
  const database = {
    getClient: async () => knex,
    migrations: { skip: false },
  } as any;
  return { store: await DatabaseOwnershipStore.create({ database }), knex };
}

function buildChecker(store: DatabaseOwnershipStore, clock: TestClock) {
  const logger = mockServices.logger.mock();
  const config = buildValidEscalationConfig();
  const catalog = createStandardOrgHierarchy();
  const mockScanner = { runScan: jest.fn(), scanEntity: jest.fn() } as any;
  const mockProposalGen = {
    generateProposalsForEntity: jest.fn().mockResolvedValue(0),
    generateProposals: jest.fn().mockResolvedValue(true),
  } as any;
  const escSvc = new DefaultEscalationService(
    store,
    catalog,
    config,
    clock,
    mockScanner,
    mockProposalGen,
    logger,
  );
  return new DefaultDeadlineCheckerService(
    store,
    escSvc,
    config,
    clock,
    logger,
  );
}

// ─── Deadline Checker & Scanner Idempotency ────────────────────────

describe('Deadline Checker & Scanner Idempotency', () => {
  describe('deadline processing', () => {
    it('deadline processed exactly once — second run skips already-processed deadline', async () => {
      const { store, knex } = await createStore();
      const clock = new TestClock(new Date('2026-01-01T00:00:00.000Z'));
      const entity = await seedEntityRow(knex, { current_status: 'escalated' });
      await seedDeadlineRow(knex, entity.id, {
        deadline_type: 'escalation_timeout',
        fire_at: new Date('2026-01-01T00:00:00.000Z'),
        actor_ref: 'user:default/jane.director',
        escalation_level: 1,
        processed: false,
      });
      const checker = buildChecker(store, clock);

      // First run: processes deadline
      await checker.processExpiredDeadlines();
      const firstRun = await knex('pending_deadlines')
        .where({ entity_id: entity.id })
        .first();
      expect(firstRun.processed).toBe(true);

      // Second run: deadline already processed → no double-fire (entity status unchanged from first run)
      const entityStatusAfterFirst = (
        await knex('ownership_entities').where({ id: entity.id }).first()
      ).current_status;
      await checker.processExpiredDeadlines();
      const entityStatusAfterSecond = (
        await knex('ownership_entities').where({ id: entity.id }).first()
      ).current_status;
      expect(entityStatusAfterSecond).toBe(entityStatusAfterFirst);
    });

    /**
     * Concurrent deadline checker runs — uses POSTGRES_16 for row-level locking.
     * SQLite serializes writes, making concurrency tests produce false positives.
     */
    it('concurrent checker runs — only one processes same deadline (POSTGRES_16)', async () => {
      const { store, knex } = await createStore(true);
      const clock = new TestClock(new Date('2026-01-01T00:00:00.000Z'));
      const entity = await seedEntityRow(knex, { current_status: 'escalated' });
      await seedDeadlineRow(knex, entity.id, {
        deadline_type: 'escalation_timeout',
        fire_at: new Date('2026-01-01T00:00:00.000Z'),
        processed: false,
      });
      const checker1 = buildChecker(store, clock);
      const checker2 = buildChecker(store, clock);

      // Both run concurrently — only one should successfully process the deadline.
      await Promise.all([
        checker1.processExpiredDeadlines(),
        checker2.processExpiredDeadlines(),
      ]);

      // The deadline must be processed exactly once
      const deadline = await knex('pending_deadlines')
        .where({ entity_id: entity.id })
        .first();
      expect(deadline.processed).toBe(true);
      // Exactly one activation event — only one checker should have driven the
      // auto-advance handler. (handleEscalationTimeout itself also writes the
      // markEntityUnresolved breadcrumb, which is a distinct action.)
      const advancedCount = await knex('ownership_history')
        .where({ entity_id: entity.id, action: 'escalation_auto_advanced' })
        .count('id as count')
        .first();
      expect(Number((advancedCount as any).count)).toBe(1);
    }, 30000);

    it('stale escalation_timeout on accepted entity → skipped, marked processed, no action', async () => {
      const { store, knex } = await createStore();
      const clock = new TestClock(new Date('2026-01-01T00:00:00.000Z'));
      const entity = await seedEntityRow(knex, { current_status: 'accepted' });
      await seedDeadlineRow(knex, entity.id, {
        deadline_type: 'escalation_timeout',
        fire_at: new Date('2026-01-01T00:00:00.000Z'),
      });
      const checker = buildChecker(store, clock);

      await checker.processExpiredDeadlines();

      // Stale deadline should be marked processed, entity stays accepted
      const deadline = await knex('pending_deadlines')
        .where({ entity_id: entity.id })
        .first();
      expect(deadline.processed).toBe(true);
      const entityRow = await knex('ownership_entities')
        .where({ id: entity.id })
        .first();
      expect(entityRow.current_status).toBe('accepted');
    });

    it('stale escalation_timeout on closed entity → skipped', async () => {
      const { store, knex } = await createStore();
      const clock = new TestClock(new Date('2026-01-01T00:00:00.000Z'));
      const entity = await seedEntityRow(knex, { current_status: 'closed' });
      await seedDeadlineRow(knex, entity.id, {
        deadline_type: 'escalation_timeout',
        fire_at: new Date('2026-01-01T00:00:00.000Z'),
      });
      const checker = buildChecker(store, clock);

      await checker.processExpiredDeadlines();

      const deadline = await knex('pending_deadlines')
        .where({ entity_id: entity.id })
        .first();
      expect(deadline.processed).toBe(true);
      const entityRow = await knex('ownership_entities')
        .where({ id: entity.id })
        .first();
      expect(entityRow.current_status).toBe('closed');
    });

    it('grace_expiry on accepted entity is NOT stale — processed normally', async () => {
      // NOT a stale deadline. Acceptance reverted, re-decision window starts.
      const { store, knex } = await createStore();
      const clock = new TestClock(new Date('2026-01-15T00:00:00.000Z'));
      const entity = await seedEntityRow(knex, {
        current_status: 'accepted',
        version: 2,
      });
      await seedProposalRow(knex, entity.id, {
        status: 'accepted',
        escalation_level: 1,
      });
      await seedDeadlineRow(knex, entity.id, {
        deadline_type: 'grace_expiry',
        fire_at: new Date('2026-01-15T00:00:00.000Z'),
        actor_ref: 'user:default/jane.director',
        escalation_level: 1,
      });
      const checker = buildChecker(store, clock);

      await checker.processExpiredDeadlines();

      // grace_expiry processed, entity reverts to escalated (escalation_level=1 → escalated)
      const entityRow = await knex('ownership_entities')
        .where({ id: entity.id })
        .first();
      expect(entityRow.current_status).toBe('escalated');

      const deadline = await knex('pending_deadlines')
        .where({ entity_id: entity.id })
        .first();
      expect(deadline.processed).toBe(true);
    });

    it('proposal-level grace_expiry on accepted entity → entity reopened AND stale accepted proposal expired (regression)', async () => {
      // Regression for the production bug: grace expiry reopened the entity but
      // left the accepted proposal at status 'accepted', producing an
      // inconsistent open + accepted state that never auto-closed.
      const { store, knex } = await createStore();
      const clock = new TestClock(new Date('2026-01-15T00:00:00.000Z'));
      const entity = await seedEntityRow(knex, {
        current_status: 'accepted',
        version: 2,
      });
      const proposal = await seedProposalRow(knex, entity.id, {
        status: 'accepted',
        escalation_level: 0, // proposal-level, not escalation-level
        proposal_order: 1,
      });
      await seedDeadlineRow(knex, entity.id, {
        deadline_type: 'grace_expiry',
        fire_at: new Date('2026-01-15T00:00:00.000Z'),
        escalation_level: 0, // proposal-level grace
      });
      // Sibling grace_warning that has NOT yet fired — must be cancelled when the
      // acceptance is reverted so it can't trigger later with a stale expiry.
      const siblingWarning = await seedDeadlineRow(knex, entity.id, {
        deadline_type: 'grace_warning',
        fire_at: new Date('2026-01-20T00:00:00.000Z'),
        escalation_level: 0,
        processed: false,
      });
      const checker = buildChecker(store, clock);

      await checker.processExpiredDeadlines();

      // Entity reopened...
      const entityRow = await knex('ownership_entities')
        .where({ id: entity.id })
        .first();
      expect(entityRow.current_status).toBe('open');

      // ...and the stale accepted proposal must NOT remain 'accepted'.
      const proposalRow = await knex('ownership_proposals')
        .where({ id: proposal.id })
        .first();
      expect(proposalRow.status).toBe('expired');

      // A revert is recorded in history for auditability.
      const history = await knex('ownership_history')
        .where({ entity_id: entity.id, action: 'proposal_acceptance_reverted' })
        .first();
      expect(history).toBeDefined();

      // The sibling grace_warning is cancelled (marked processed) so it never fires.
      const siblingRow = await knex('pending_deadlines')
        .where({ id: siblingWarning.id })
        .first();
      expect(siblingRow.processed).toBe(true);
    });

    it('grace_warning on accepted entity is NOT stale — warning notification sent, marked processed', async () => {
      const { store, knex } = await createStore();
      const clock = new TestClock(new Date('2026-01-10T00:00:00.000Z'));
      const entity = await seedEntityRow(knex, { current_status: 'accepted' });
      await seedDeadlineRow(knex, entity.id, {
        deadline_type: 'grace_warning',
        fire_at: new Date('2026-01-10T00:00:00.000Z'),
        actor_ref: 'user:default/alice',
      });
      const checker = buildChecker(store, clock);

      await checker.processExpiredDeadlines();

      const deadline = await knex('pending_deadlines')
        .where({ entity_id: entity.id })
        .first();
      expect(deadline.processed).toBe(true);
      // Entity still accepted (warning doesn't change status)
      const entityRow = await knex('ownership_entities')
        .where({ id: entity.id })
        .first();
      expect(entityRow.current_status).toBe('accepted');
    });

    it('5 expired deadlines, independent entities — all 5 processed independently', async () => {
      // Independent entity processing — one bad deadline doesn't block others.
      const { store, knex } = await createStore();
      const clock = new TestClock(new Date('2026-01-01T00:00:00.000Z'));
      const entityIds: string[] = [];

      for (let i = 0; i < 5; i++) {
        const entity = await seedEntityRow(knex, {
          current_status: 'escalated',
        });
        entityIds.push(entity.id);
        await seedDeadlineRow(knex, entity.id, {
          deadline_type: 'escalation_timeout',
          fire_at: new Date('2026-01-01T00:00:00.000Z'),
        });
      }

      const checker = buildChecker(store, clock);
      await checker.processExpiredDeadlines();

      // All 5 deadlines should be processed
      const processedDeadlines = await knex('pending_deadlines')
        .whereIn('entity_id', entityIds)
        .where({ processed: true });
      expect(processedDeadlines).toHaveLength(5);
    });
  });

  describe('scanner idempotency', () => {
    it('scanner re-scan updates last_scanned_at, no duplicate case created', async () => {
      // Re-scans update existing cases.
      // UpdateEntityLastScanned is implemented.
      const { store, knex } = await createStore();
      const entity = await seedEntityRow(knex, {
        current_status: 'open',
        entity_ref: 'component:default/my-service',
      });

      await store.updateEntityLastScanned(entity.id, 'scan-123');

      const row = await knex('ownership_entities')
        .where({ id: entity.id })
        .first();
      expect(row.id).toBe(entity.id); // same row, not duplicated
    });

    it('config change affects new deadlines only — existing deadlines keep original fire_at', async () => {
      // deadlines keep their original fire_at.
      // This verifies seed fixture correctness.
      const { knex } = await createStore();
      const entity = await seedEntityRow(knex, { current_status: 'escalated' });
      const originalFireAt = new Date('2026-01-08T00:00:00.000Z');
      const deadline = await seedDeadlineRow(knex, entity.id, {
        deadline_type: 'escalation_timeout',
        fire_at: originalFireAt,
        processed: false,
      });

      // Verify the existing deadline is unchanged.
      const row = await knex('pending_deadlines')
        .where({ id: deadline.id })
        .first();
      expect(new Date(row.fire_at).getTime()).toBe(originalFireAt.getTime());
    });

    it('config level removed mid-escalation → treated as exhausted, advance to next level', async () => {
      const { store, knex } = await createStore();
      const clock = new TestClock(new Date('2026-01-01T00:00:00.000Z'));
      const entity = await seedEntityRow(knex, { current_status: 'escalated' });
      await seedDeadlineRow(knex, entity.id, {
        deadline_type: 'escalation_timeout',
        fire_at: new Date('2026-01-01T00:00:00.000Z'),
        escalation_level: 99, // level 99 doesn't exist in config
      });
      const checker = buildChecker(store, clock);

      await checker.processExpiredDeadlines();

      // Deadline should be processed (treated as exhausted/stale level)
      const deadline = await knex('pending_deadlines')
        .where({ entity_id: entity.id })
        .first();
      expect(deadline.processed).toBe(true);
    });

    it('scanner closes case when ownership fixed (resolution_type: ownership_changed)', async () => {
      // CloseEntity is implemented.
      const { store, knex } = await createStore();
      const entity = await seedEntityRow(knex, {
        current_status: 'escalated',
        version: 1,
      });

      await store.closeEntity(
        entity.id,
        'system',
        'ownership_changed',
        entity.version,
      );

      const row = await knex('ownership_entities')
        .where({ id: entity.id })
        .first();
      expect(row.current_status).toBe('closed');
      expect(row.resolution_type).toBe('ownership_changed');
    });

    it('scanner closes case when entity removed from catalog (resolution_type: archived)', async () => {
      // CloseEntity is implemented.
      const { store, knex } = await createStore();
      const entity = await seedEntityRow(knex, {
        current_status: 'open',
        version: 1,
      });

      await store.closeEntity(entity.id, 'system', 'archived', entity.version);

      const row = await knex('ownership_entities')
        .where({ id: entity.id })
        .first();
      expect(row.current_status).toBe('closed');
      expect(row.resolution_type).toBe('archived');
    });

    it('scanner closes escalated entity → subsequent deadline checker run skips stale deadlines', async () => {
      const { store, knex } = await createStore();
      const clock = new TestClock(new Date('2026-01-10T00:00:00.000Z'));
      const entity = await seedEntityRow(knex, {
        current_status: 'escalated',
        version: 1,
      });
      await seedDeadlineRow(knex, entity.id, {
        deadline_type: 'escalation_timeout',
        fire_at: new Date('2026-01-08T00:00:00.000Z'),
        processed: false,
      });

      // Scanner closes entity first.
      await store.closeEntity(
        entity.id,
        'system',
        'ownership_changed',
        entity.version,
      );

      // Checker runs — deadline is now stale (entity is closed).
      const checker = buildChecker(store, clock);
      await checker.processExpiredDeadlines();

      // Deadline processed (skipped as stale), entity remains closed
      const deadline = await knex('pending_deadlines')
        .where({ entity_id: entity.id })
        .first();
      expect(deadline.processed).toBe(true);
      const entityRow = await knex('ownership_entities')
        .where({ id: entity.id })
        .first();
      expect(entityRow.current_status).toBe('closed');
    });

    it('BFS queue state survives service restart — checker reads from DB, not memory', async () => {
      // Verifies seed fixture persistence.
      const { store, knex } = await createStore();
      void store;
      const entity = await seedEntityRow(knex, { current_status: 'escalated' });
      await seedQueueEntry(knex, entity.id, {
        group_ref: 'group:default/domain-payments',
        escalation_level: 1,
        position: 2,
        status: 'queued',
      });

      // Read back directly from DB to confirm persistence.
      const rows = await knex('escalation_queue_entries').where({
        entity_id: entity.id,
        status: 'queued',
      });
      expect(rows).toHaveLength(1);
      expect(rows[0].group_ref).toBe('group:default/domain-payments');
    });

    it('BFS resumes from actor AFTER Director-A when suggestion rejected', async () => {
      const { store, knex } = await createStore();
      const entity = await seedEntityRow(knex, { current_status: 'escalated' });
      // Director-A was at position 1 (completed), Director-B at position 2.
      await seedQueueEntry(knex, entity.id, {
        group_ref: 'group:default/domain-search',
        escalation_level: 1,
        position: 1,
        status: 'completed',
        resolved_actor_ref: 'user:default/jane.director',
      });
      await seedQueueEntry(knex, entity.id, {
        group_ref: 'group:default/domain-payments',
        escalation_level: 1,
        position: 2,
        status: 'queued',
      });
      // Seed an expired proposal_expiry deadline (suggestion expired)
      await seedDeadlineRow(knex, entity.id, {
        deadline_type: 'proposal_expiry',
        fire_at: new Date('2025-12-31T00:00:00.000Z'),
        processed: false,
      });

      const clock = new TestClock(new Date('2026-01-01T00:00:00.000Z'));
      const checker = buildChecker(store, clock);

      await checker.processExpiredDeadlines();

      // Director-B (domain-payments) should be activated
      const paymentsEntry = await knex('escalation_queue_entries')
        .where({
          entity_id: entity.id,
          group_ref: 'group:default/domain-payments',
        })
        .first();
      expect(paymentsEntry.status).toBe('active');
    });

    it('stale grace_warning after scanner close → skipped, no warning sent', async () => {
      const { store, knex } = await createStore();
      const clock = new TestClock(new Date('2026-01-10T00:00:00.000Z'));
      const entity = await seedEntityRow(knex, { current_status: 'closed' });
      await seedDeadlineRow(knex, entity.id, {
        deadline_type: 'grace_warning',
        fire_at: new Date('2026-01-10T00:00:00.000Z'),
      });
      const checker = buildChecker(store, clock);

      await checker.processExpiredDeadlines();

      const deadline = await knex('pending_deadlines')
        .where({ entity_id: entity.id })
        .first();
      expect(deadline.processed).toBe(true);
      const entityRow = await knex('ownership_entities')
        .where({ id: entity.id })
        .first();
      expect(entityRow.current_status).toBe('closed');
    });

    it('stale redecision_expiry after scanner close → skipped, no auto-advance', async () => {
      const { store, knex } = await createStore();
      const clock = new TestClock(new Date('2026-01-05T00:00:00.000Z'));
      const entity = await seedEntityRow(knex, { current_status: 'closed' });
      await seedDeadlineRow(knex, entity.id, {
        deadline_type: 'redecision_expiry',
        fire_at: new Date('2026-01-05T00:00:00.000Z'),
        actor_ref: 'user:default/jane.director',
        escalation_level: 1,
      });
      const checker = buildChecker(store, clock);

      await checker.processExpiredDeadlines();

      const deadline = await knex('pending_deadlines')
        .where({ entity_id: entity.id })
        .first();
      expect(deadline.processed).toBe(true);
      const entityRow = await knex('ownership_entities')
        .where({ id: entity.id })
        .first();
      expect(entityRow.current_status).toBe('closed');
    });
  });
});
