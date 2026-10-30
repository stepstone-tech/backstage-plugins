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
 * History logging.
 *
 * Verifies that the HistoryAction union contains the correct types, that legacy
 * types were removed, and that history is immutable.
 *
 * Type-union tests use @ts-expect-error to assert at compile time that removed
 * types no longer exist, rather than relying on a hardcoded array.
 */

import { mockServices, TestDatabases } from '@backstage/backend-test-utils';
import { DatabaseOwnershipStore } from '../service/DatabaseOwnershipStore';
import { DefaultEscalationService } from './EscalationService';
import type { HistoryAction } from '../types';
import { HistoryStore } from '../service/stores/HistoryStore';
import { createStandardOrgHierarchy } from './__fixtures__/createMockCatalog';
import { buildValidEscalationConfig } from './__fixtures__/buildEscalationConfig';
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

function buildService(store: DatabaseOwnershipStore) {
  const catalog = createStandardOrgHierarchy();
  const config = buildValidEscalationConfig();
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

// ─── History Logging ────────────────────────────────────────────────

describe('History Logging', () => {
  describe('new escalation action types present in union', () => {
    it('escalation_triggered action type exists in HistoryAction union', () => {
      // This is a compile-time check.
      const action: HistoryAction = 'escalation_triggered';
      expect(action).toBe('escalation_triggered');
    });

    it('no_candidates_found is a distinct action type from escalation_triggered', () => {
      // Compile-time check.
      const action: HistoryAction = 'no_candidates_found';
      expect(action).toBe('no_candidates_found');
      expect(action).not.toBe('escalation_triggered');
    });

    it('escalation_notified action type exists in HistoryAction union', () => {
      const action: HistoryAction = 'escalation_notified';
      expect(action).toBe('escalation_notified');
    });

    it('escalation_rejected action type exists in HistoryAction union', () => {
      const action: HistoryAction = 'escalation_rejected';
      expect(action).toBe('escalation_rejected');
    });

    it('escalation_suggested_created action type exists', () => {
      const action: HistoryAction = 'escalation_suggested_created';
      expect(action).toBe('escalation_suggested_created');
    });

    it('escalation_suggested_rejected action type exists', () => {
      const action: HistoryAction = 'escalation_suggested_rejected';
      expect(action).toBe('escalation_suggested_rejected');
    });

    it('escalation_exhausted action type exists', () => {
      const action: HistoryAction = 'escalation_exhausted';
      expect(action).toBe('escalation_exhausted');
    });

    it('escalation_notified with skipped details exists in union', () => {
      const action: HistoryAction = 'escalation_notified';
      expect(action).toBe('escalation_notified');
    });
  });

  describe('auto-readjust action types present in union', () => {
    it('escalation_queue_revalidated action type exists', () => {
      const action: HistoryAction = 'escalation_queue_revalidated';
      expect(action).toBe('escalation_queue_revalidated');
    });

    it('escalation_queue_entry_removed action type exists', () => {
      const action: HistoryAction = 'escalation_queue_entry_removed';
      expect(action).toBe('escalation_queue_entry_removed');
    });

    it('escalation_queue_entry_added action type exists', () => {
      const action: HistoryAction = 'escalation_queue_entry_added';
      expect(action).toBe('escalation_queue_entry_added');
    });

    it('escalation_queue_entry_skipped action type exists', () => {
      const action: HistoryAction = 'escalation_queue_entry_skipped';
      expect(action).toBe('escalation_queue_entry_skipped');
    });
  });

  describe('removed action types — @ts-expect-error compile-time assertions', () => {
    it('escalation_passed is NOT in the HistoryAction union (TypeScript compile-time check)', () => {
      // The @ts-expect-error asserts that assigning 'escalation_passed' to HistoryAction
      // is a TYPE ERROR. If accidentally re-adds 'escalation_passed' to HistoryAction,
      // this test will FAIL to compile (ts-expect-error becomes a ts-error).
      // @ts-expect-error - 'escalation_passed' must NOT be in HistoryAction
      const _removed: HistoryAction = 'escalation_passed';
      void _removed; // suppress unused-variable warning
      expect(true).toBe(true); // test exists so Jest counts it
    });

    it('proposal_undone is NOT in the HistoryAction union', () => {
      // @ts-expect-error - 'proposal_undone' must NOT be in HistoryAction
      const _removed: HistoryAction = 'proposal_undone';
      void _removed;
      expect(true).toBe(true);
    });

    it('proposal_reopened is NOT in the HistoryAction union', () => {
      // @ts-expect-error - 'proposal_reopened' must NOT be in HistoryAction
      const _removed: HistoryAction = 'proposal_reopened';
      void _removed;
      expect(true).toBe(true);
    });

    it('proposal_notified is NOT in the HistoryAction union', () => {
      // @ts-expect-error - 'proposal_notified' must NOT be in HistoryAction
      const _removed: HistoryAction = 'proposal_notified';
      void _removed;
      expect(true).toBe(true);
    });
  });

  describe('history written correctly by service (integration)', () => {
    it('triggerEscalation writes escalation_triggered history action', async () => {
      const { store, knex } = await createStore();
      const entity = await seedEntityRow(knex, { current_status: 'open' });
      await seedProposalRow(knex, entity.id, {
        proposed_owner_ref: 'group:default/team-a',
        status: 'rejected',
        proposal_order: 1,
      });
      const svc = buildService(store);

      await svc.triggerEscalation(entity.id);

      const history = await knex('ownership_history')
        .where({ entity_id: entity.id, action: 'escalation_triggered' })
        .first();
      expect(history).toBeDefined();
      expect(history.actor).toBe('system');
    });

    it('no candidates → no_candidates_found history action (not escalation_triggered)', async () => {
      const { store, knex } = await createStore();
      const entity = await seedEntityRow(knex, { current_status: 'open' });
      // No proposals → no candidates.
      const svc = buildService(store);

      await svc.triggerEscalation(entity.id);

      const history = await knex('ownership_history')
        .where({ entity_id: entity.id, action: 'no_candidates_found' })
        .first();
      expect(history).toBeDefined();

      // Must NOT write escalation_triggered for no-candidates path
      const wrongHistory = await knex('ownership_history')
        .where({ entity_id: entity.id, action: 'escalation_triggered' })
        .first();
      expect(wrongHistory).toBeUndefined();
    });

    it('escalationReject writes escalation_rejected with mandatory reason in details', async () => {
      const { store, knex } = await createStore();
      const entity = await seedEntityRow(knex, { current_status: 'escalated' });
      await seedQueueEntry(knex, entity.id, {
        group_ref: 'group:default/domain-search',
        status: 'active',
        resolved_actor_ref: 'user:default/jane.director',
      });
      const svc = buildService(store);

      await svc.escalationReject(
        entity.id,
        'user:default/jane.director',
        'Not our scope',
      );

      const history = await knex('ownership_history')
        .where({ entity_id: entity.id, action: 'escalation_rejected' })
        .first();
      expect(history).toBeDefined();
      expect(history.actor).toBe('user:default/jane.director');
      // Reason stored in details
      const details =
        typeof history.details === 'string'
          ? JSON.parse(history.details)
          : history.details;
      expect(details).toMatchObject({ reason: 'Not our scope' });
    });

    it('escalationSuggest writes escalation_suggested_created history', async () => {
      const { store, knex } = await createStore();
      const entity = await seedEntityRow(knex, { current_status: 'escalated' });
      await seedQueueEntry(knex, entity.id, {
        group_ref: 'group:default/domain-search',
        status: 'active',
        resolved_actor_ref: 'user:default/jane.director',
      });
      const svc = buildService(store);

      await svc.escalationSuggest(
        entity.id,
        'group:default/team-d',
        'Team-D fits this domain',
        'user:default/jane.director',
      );

      const history = await knex('ownership_history')
        .where({ entity_id: entity.id, action: 'escalation_suggested_created' })
        .first();
      expect(history).toBeDefined();
      expect(history.actor).toBe('user:default/jane.director');
    });

    it('all levels exhausted → escalation_exhausted history with all_escalation_paths reason', async () => {
      const { store, knex } = await createStore();
      const entity = await seedEntityRow(knex, { current_status: 'escalated' });
      // No queued entries → exhausted
      const svc = buildService(store);

      await svc.activateNextEntry(entity.id);

      const history = await knex('ownership_history')
        .where({ entity_id: entity.id, action: 'escalation_exhausted' })
        .first();
      expect(history).toBeDefined();
      const details =
        typeof history.details === 'string'
          ? JSON.parse(history.details)
          : history.details;
      expect(details?.reason).toBe('all_escalation_paths');
    });
  });

  describe('history immutability', () => {
    it('history store only inserts — no UPDATE or DELETE on ownership_history', async () => {
      // Verifies the HistoryStore interface.
      // HistoryStore imported at top level
      const historyStoreProto = HistoryStore.prototype;

      expect(typeof historyStoreProto.appendHistory).toBe('function');
      expect((historyStoreProto as any).updateHistory).toBeUndefined();
      expect((historyStoreProto as any).deleteHistory).toBeUndefined();
    });

    it('history rows can be read but not overwritten via store interface', async () => {
      // Integration test: write a history row, verify it persists unchanged.
      // AppendHistory and listHistory are implemented.
      const { store, knex } = await createStore();
      const entity = await seedEntityRow(knex, { current_status: 'escalated' });

      await store.appendHistory({
        entity_id: entity.id,
        action: 'escalation_triggered',
        actor: 'system',
        details: { reason: 'candidates_exhausted' },
      });

      const history = await store.listHistory(entity.id);
      expect(history).toHaveLength(1);
      expect(history[0].action).toBe('escalation_triggered');
      // Verify no update method exists on the store interface.
      expect((store as any).updateHistory).toBeUndefined();
      expect((store as any).deleteHistory).toBeUndefined();
    });
  });
});
