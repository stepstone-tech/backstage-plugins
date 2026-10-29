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
 * Optimistic Concurrency & Transactions.
 *
 * All scenarios use POSTGRES_16 for proper row-level locking semantics —
 * SQLite serializes writes and would produce false positives.
 */

import {
  mockCredentials,
  mockErrorHandler,
  mockServices,
  TestDatabases,
} from '@backstage/backend-test-utils';
import express from 'express';
import request from 'supertest';
import { ConflictError } from '@backstage/errors';
import { DatabaseOwnershipStore } from '../service/DatabaseOwnershipStore';
import { DefaultEscalationService } from './EscalationService';
import { createEscalationRouter } from './router';
import { CatalogService } from '@stepstone-tech/backstage-plugin-ownership-matcher-node';
import { createStandardOrgHierarchy } from './__fixtures__/createMockCatalog';
import { buildValidEscalationConfig } from './__fixtures__/buildEscalationConfig';
import { TestClock } from './__fixtures__/Clock';
import {
  seedEntityRow,
  seedProposalRow,
  seedQueueEntry,
} from './__fixtures__/seedEntity';
import { toOwnershipEntity } from '../types';

// ALL concurrency tests use POSTGRES_16 — SQLite serializes writes.
const pgDatabases = TestDatabases.create({ ids: ['POSTGRES_16'] });

async function createStore() {
  const knex = await pgDatabases.init('POSTGRES_16');
  const database = {
    getClient: async () => knex,
    migrations: { skip: false },
  } as any;
  return { store: await DatabaseOwnershipStore.create({ database }), knex };
}

async function buildEscalationApp(
  store: DatabaseOwnershipStore,
  actorRef = 'user:default/jane.director',
) {
  const config = buildValidEscalationConfig();
  const catalog = createStandardOrgHierarchy();
  const clock = new TestClock();
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
    clock,
    mockScanner,
    mockProposalGen,
    logger,
  );
  const mockCatalogService = {
    isUserMemberOfGroup: jest.fn().mockResolvedValue(false),
    getLiveGroupRegistry: jest.fn().mockResolvedValue(new Set()),
    getGroupMembersWithTitles: jest.fn().mockResolvedValue([]),
    walkGroupHierarchy: jest.fn().mockResolvedValue([]),
    getGroupsByFilter: jest.fn().mockResolvedValue([]),
  } as unknown as CatalogService;
  const router = await createEscalationRouter({
    httpAuth: mockServices.httpAuth({
      defaultCredentials: mockCredentials.user(actorRef),
    }),
    store,
    escalationService: svc,
    catalogService: mockCatalogService,
    config,
  });
  const app = express().use(router).use(mockErrorHandler());
  return { app };
}

// ─── Optimistic Concurrency & Transactions ─────────────────────────

describe('Optimistic Concurrency & Transactions (POSTGRES_16)', () => {
  describe('version conflict — store-level (already implemented)', () => {
    it('concurrent entity update — first writer wins, second gets ConflictError (409)', async () => {
      const { store, knex } = await createStore();
      const entity = await seedEntityRow(knex, {
        current_status: 'open',
        version: 5,
      });

      // Both read version 5 simultaneously.
      const [result1, result2] = await Promise.allSettled([
        store.acceptEntity(
          entity.id,
          'user:default/alice',
          'ownership_changed',
          5,
        ),
        store.acceptEntity(
          entity.id,
          'user:default/bob',
          'ownership_changed',
          5,
        ),
      ]);

      // Exactly one succeeds, one fails with ConflictError.
      const fulfilled = [result1, result2].filter(
        r => r.status === 'fulfilled',
      );
      const rejected = [result1, result2].filter(r => r.status === 'rejected');
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(
        ConflictError,
      );
    });

    it('version incremented after successful update', async () => {
      const { store, knex } = await createStore();
      const entity = await seedEntityRow(knex, {
        current_status: 'open',
        version: 1,
      });

      await store.acceptEntity(entity.id, 'system', 'ownership_changed', 1);

      const row = await knex('ownership_entities')
        .where({ id: entity.id })
        .first();
      expect(row.version).toBe(2);
    });

    it('stale version → ConflictError', async () => {
      const { store, knex } = await createStore();
      const entity = await seedEntityRow(knex, {
        current_status: 'open',
        version: 3,
      });

      await expect(
        store.acceptEntity(entity.id, 'system', 'ownership_changed', 1), // wrong version
      ).rejects.toThrow(ConflictError);
    });
  });

  describe('version conflict — HTTP layer (concurrent escalation actions)', () => {
    it('concurrent escalation actions — first wins 200, second gets 409', async () => {
      const { store, knex } = await createStore();
      const entity = await seedEntityRow(knex, {
        current_status: 'escalated',
        version: 1,
      });
      await seedQueueEntry(knex, entity.id, {
        group_ref: 'group:default/domain-search',
        status: 'active',
        resolved_actor_ref: 'user:default/jane.director',
        escalation_level: 1,
      });
      const { app } = await buildEscalationApp(
        store,
        'user:default/jane.director',
      );

      const [res1, res2] = await Promise.all([
        request(app)
          .post(`/entities/${entity.id}/escalation/assign`)
          .send({ ownerRef: 'group:default/team-a' }),
        request(app)
          .post(`/entities/${entity.id}/escalation/reject`)
          .send({ reason: 'Concurrent reject' }),
      ]);

      const statuses = [res1.status, res2.status].sort();
      expect(statuses).toEqual([200, 409]);
    });
  });

  describe('transactions (withTransaction)', () => {
    it('transaction rollback on partial failure — proposal status unchanged after error', async () => {
      const { store, knex } = await createStore();
      const entity = await seedEntityRow(knex, {
        current_status: 'open',
        version: 1,
      });
      const proposal = await seedProposalRow(knex, entity.id, {
        status: 'pending',
        proposal_order: 1,
      });

      await expect(
        store.withTransaction(async stores => {
          await stores.proposalStore.updateProposalStatus(
            proposal.id,
            'accepted',
          );
          throw new Error('Simulated failure');
        }),
      ).rejects.toThrow();

      // After rollback: proposal must still be pending.
      const proposalRow = await knex('ownership_proposals')
        .where({ id: proposal.id })
        .first();
      expect(proposalRow.status).toBe('pending');
    });

    it('cancelled bulk cleanup in same transaction as accept — atomic operation', async () => {
      const { store, knex } = await createStore();
      const entity = await seedEntityRow(knex, {
        current_status: 'escalated',
        version: 1,
      });
      const p1 = await seedProposalRow(knex, entity.id, {
        status: 'pending',
        proposal_order: 1,
      });
      const p2 = await seedProposalRow(knex, entity.id, {
        proposed_owner_ref: 'group:default/team-b',
        status: 'pending',
        proposal_order: 2,
      });
      const p3 = await seedProposalRow(knex, entity.id, {
        proposed_owner_ref: 'group:default/team-c',
        status: 'pending',
        proposal_order: 3,
      });

      await store.withTransaction(async stores => {
        await stores.proposalStore.updateProposalStatus(p1.id, 'accepted');
        await stores.proposalStore.updateProposalStatus(p2.id, 'cancelled');
        await stores.proposalStore.updateProposalStatus(p3.id, 'cancelled');
      });

      const rows = await knex('ownership_proposals')
        .whereIn('id', [p1.id, p2.id, p3.id])
        .orderBy('proposal_order');
      expect(rows[0].status).toBe('accepted');
      expect(rows[1].status).toBe('cancelled');
      expect(rows[2].status).toBe('cancelled');
    });

    it('deadline checker concurrent update — version conflict → exactly one wins (POSTGRES_16)', async () => {
      // Concurrent user action modifies entity between read and write → 409.
      const { store, knex } = await createStore();
      const entity = await seedEntityRow(knex, {
        current_status: 'escalated',
        version: 1,
      });

      // Concurrent operations: deadline checker path and user acceptance.
      const [result1, result2] = await Promise.allSettled([
        store.withTransaction(async stores => {
          await stores.entityStore.setEntityUnresolved(entity.id, 1);
        }),
        store.acceptEntity(
          entity.id,
          'user:default/alice',
          'ownership_changed',
          1,
        ),
      ]);

      // Exactly one fulfills, one rejects with ConflictError.
      const fulfilled = [result1, result2].filter(
        r => r.status === 'fulfilled',
      );
      const rejected = [result1, result2].filter(r => r.status === 'rejected');
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(
        ConflictError,
      );
    }, 30000);

    it('scanner uses optimistic concurrency — concurrent escalation action → first writer wins', async () => {
      // → first writer wins, second gets ConflictError.
      const { store, knex } = await createStore();
      const entity = await seedEntityRow(knex, {
        current_status: 'escalated',
        version: 2,
      });

      const [result1, result2] = await Promise.allSettled([
        store.closeEntity(entity.id, 'system', 'ownership_changed', 2),
        store.setEntityUnresolved(entity.id, 2),
      ]);

      const fulfilled = [result1, result2].filter(
        r => r.status === 'fulfilled',
      );
      const rejected = [result1, result2].filter(r => r.status === 'rejected');
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(
        ConflictError,
      );
    });
  });

  describe('version is backend-internal', () => {
    it('version column exists in DB but is NOT in OwnershipEntity DTO', async () => {
      // Verifies type stripping in toOwnershipEntity.
      const { knex } = await createStore();
      const entity = await seedEntityRow(knex, {
        current_status: 'open',
        version: 1,
      });

      const row = await knex('ownership_entities')
        .where({ id: entity.id })
        .first();
      expect(row.version).toBeDefined(); // exists in DB

      // toOwnershipEntity imported at top level
      const dto = toOwnershipEntity({
        ...row,
        first_detected_at: new Date(),
        last_scanned_at: new Date(),
      });
      expect((dto as any).version).toBeUndefined(); // not in DTO
    });
  });
});
