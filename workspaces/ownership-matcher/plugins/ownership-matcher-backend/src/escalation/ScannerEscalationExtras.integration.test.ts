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
 * Supplementary integration tests for the scanner-bypass fix.
 *
 * Regression-bait scenarios not covered in ScannerEscalation.test.ts. Uses
 * real Postgres (POSTGRES_16).
 */

import {
  mockCredentials,
  mockErrorHandler,
  mockServices,
  TestDatabases,
} from '@backstage/backend-test-utils';
import { randomUUID } from 'crypto';
import express from 'express';
import request from 'supertest';
import { DatabaseOwnershipStore } from '../service/DatabaseOwnershipStore';
import { DefaultEscalationService } from './EscalationService';
import { LazyEscalationTrigger } from './EscalationTrigger';
import { CatalogService } from '@stepstone-tech/backstage-plugin-ownership-matcher-node';
import {
  createMockCatalog,
  createStandardOrgHierarchy,
} from './__fixtures__/createMockCatalog';
import { buildValidEscalationConfig } from './__fixtures__/buildEscalationConfig';
import { TestClock } from './__fixtures__/Clock';
import {
  seedEntityRow,
  seedProposalRow,
  seedQueueEntry,
} from './__fixtures__/seedEntity';
import { ProposalLifecycleService } from '../service/ProposalLifecycleService';
import { EntityProcessingService } from '../service/EntityProcessingService';
import { ProposalGenerationService } from '../service/ProposalGenerationService';
import { ScmRegistry } from '../scm';
import { OwnershipCheck, OwnershipCheckContext } from '../checks';
import { CatalogComponent } from '../types';
import { ScanStats } from '../service/OwnershipMatcherService';
import { createRouter } from '../router';

jest.setTimeout(60_000);

const databases = TestDatabases.create({ ids: ['POSTGRES_16'] });

// Initialised once per test-file run; migrations execute only on the first call.
let cachedStore: { store: DatabaseOwnershipStore; knex: any } | undefined;

async function createStore() {
  if (cachedStore) return cachedStore;
  const knex = await databases.init('POSTGRES_16');
  const database = {
    getClient: async () => knex,
    migrations: { skip: false },
  } as any;
  cachedStore = {
    store: await DatabaseOwnershipStore.create({ database }),
    knex,
  };
  return cachedStore;
}

function buildService(
  store: DatabaseOwnershipStore,
  catalogOverride?: ReturnType<typeof createMockCatalog>,
) {
  const catalog = catalogOverride ?? createStandardOrgHierarchy();
  const config = buildValidEscalationConfig();
  const clock = new TestClock();
  const logger = mockServices.logger.mock();
  const mockScanner = { runScan: jest.fn(), scanEntity: jest.fn() } as any;
  const mockProposalGen = {
    generateProposalsForEntity: jest.fn().mockResolvedValue(0),
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

const emptyStats: ScanStats = {
  newIssuesFound: 0,
  existingIssuesUpdated: 0,
  issuesAutoResolved: 0,
  totalScanned: 0,
};

const orphanedCheck: OwnershipCheck = {
  name: 'orphaned',
  title: 'Orphaned',
  description: 'no owner',
  run: (_ctx: OwnershipCheckContext) => ({
    failed: true,
    checkName: 'orphaned',
    details: {},
  }),
};

// ─── concurrent triggers with contention barrier ──────────────
//
// The concurrent-trigger test in ScannerEscalation.integration.test.ts uses Promise.all with no
// barrier — three other guards (idempotency pre-check, ConflictError on
// setEntityEscalated, version check) catch the race before the partial UNIQUE
// is exercised. This test forces both callers past those guards by using a
// barrier on walkGroupHierarchy so both reach insertQueuePlan concurrently.
// If the partial UNIQUE migration is removed, this test must fail.

describe('contention barrier forces partial UNIQUE to fire', () => {
  it('both concurrent callers progress past idempotency guard; exactly one queue row per (level, position)', async () => {
    const { store, knex } = await createStore();
    const entity = await seedEntityRow(knex, { current_status: 'open' });
    // Seed a rejected proposal so Branch 3 (all exhausted) is taken.
    await seedProposalRow(knex, entity.id, {
      proposed_owner_ref: 'group:default/team-a',
      status: 'rejected',
      proposal_order: 1,
    });

    const catalog = createStandardOrgHierarchy();

    // Barrier: resolve only when walkGroupHierarchy has been called twice,
    // ensuring both callers are inside computeQueuePlan at the same time.
    let callCount = 0;
    let releaseBarrier: (() => void) | undefined;
    const barrier = new Promise<void>(resolve => {
      releaseBarrier = resolve;
    });

    const originalWalk = catalog.walkGroupHierarchy.bind(catalog);
    catalog.walkGroupHierarchy = jest.fn(async (ref, direction) => {
      callCount++;
      if (callCount === 2) {
        releaseBarrier!();
      }
      await barrier;
      return originalWalk(ref, direction);
    });

    const svc = buildService(store, catalog);

    await Promise.all([
      svc.triggerEscalation(entity.id),
      svc.triggerEscalation(entity.id),
    ]);

    // Both callers must have entered computeQueuePlan (proves both passed the
    // idempotency pre-check before either committed) — at least 2 calls total.
    expect(
      (catalog.walkGroupHierarchy as jest.Mock).mock.calls.length,
    ).toBeGreaterThanOrEqual(2);

    // Partial UNIQUE must have prevented duplicate active rows.
    const activeRows = await knex('escalation_queue_entries')
      .where({ entity_id: entity.id })
      .whereIn('status', ['queued', 'active']);
    const seen = new Set<string>();
    for (const r of activeRows) {
      const key = `${r.escalation_level}:${r.position}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }

    // Exactly one escalation_triggered history row.
    const triggered = await knex('ownership_history').where({
      entity_id: entity.id,
      action: 'escalation_triggered',
    });
    expect(triggered).toHaveLength(1);
  });
});

// ─── retrigger recursion guard ───────────────────────────────────────
//
// escalationRetrigger → scanEntity → processEntity → lazyTrigger.triggerEscalation
// → escalationService.triggerEscalation → hits TRIGGER_IDEMPOTENT_STATUSES guard.
// Engineer's claim that Retrigger.test.ts covers this is wrong: that file mocks
// the scanner. This test uses live wiring. If `unresolved` is removed from
// TRIGGER_IDEMPOTENT_STATUSES, the recursion guard breaks.

describe('retrigger recursion guard via live lazyTrigger wiring', () => {
  it('lazyTrigger.triggerEscalation is called at most twice; second call is a no-op (no second INSERT)', async () => {
    const { store, knex } = await createStore();
    const entity = await seedEntityRow(knex, { current_status: 'unresolved' });

    const catalog = createStandardOrgHierarchy();
    const config = buildValidEscalationConfig();
    const clock = new TestClock();
    const logger = mockServices.logger.mock();

    const lazyTrigger = new LazyEscalationTrigger();

    // Build a real scanner that uses processEntity with the lazy trigger.
    const scmRegistry = {
      repoFor: jest.fn().mockResolvedValue(undefined),
    } as unknown as ScmRegistry;

    // proposalGenerationService returns false so EPS calls triggerEscalation.
    const proposalGenerationService = {
      generateProposals: jest.fn().mockResolvedValue(false),
      generateProposalsForEntity: jest.fn().mockResolvedValue(0),
    } as unknown as ProposalGenerationService;

    const eps = new EntityProcessingService(
      scmRegistry,
      proposalGenerationService,
      store,
      [orphanedCheck],
      new Set(['orphaned']),
      logger,
      undefined,
      lazyTrigger,
      {
        getEntityByRef: jest.fn().mockResolvedValue(undefined),
      } as unknown as CatalogService,
    );

    // Stub scanner that delegates processEntity to the real EPS.
    const scanId = randomUUID();
    await knex('ownership_scans').insert({ id: scanId });

    const catalogComponent: CatalogComponent = {
      kind: entity.entity_ref.split(':')[0] as 'Component',
      metadata: {
        name: entity.entity_ref.split('/')[1],
        namespace: 'default',
      },
      spec: {},
    };

    const realScanner = {
      runScan: jest.fn(),
      scanEntity: jest.fn().mockImplementation(async () => {
        await eps.processEntity(
          catalogComponent,
          {} as OwnershipCheckContext,
          scanId,
          { ...emptyStats },
        );
        return undefined;
      }),
    } as any;

    const mockProposalGen = {
      generateProposalsForEntity: jest.fn().mockResolvedValue(0),
    } as any;

    const escalationService = new DefaultEscalationService(
      store,
      catalog,
      config,
      clock,
      realScanner,
      mockProposalGen,
      logger,
    );

    // Wire the lazy trigger BEFORE any call — this is the live circular path.
    lazyTrigger.set(escalationService);

    // Spy on the lazy trigger's delegation.
    const triggerSpy = jest.spyOn(lazyTrigger, 'triggerEscalation');

    // Retrigger requires `unresolved` entity. Because router auth is complex
    // to wire here, we call the service method directly after the router's
    // 409-check (the entity IS unresolved, so this is valid).
    await escalationService.escalationRetrigger(
      entity.id,
      'user:default/fallback.user',
    );

    // The spy should have been called at most twice:
    // call 1: from EPS.handleRedetection inside the scanner stub
    // call 2 (recursive): escalationService.triggerEscalation — immediately
    // returns via TRIGGER_IDEMPOTENT_STATUSES guard
    expect(triggerSpy.mock.calls.length).toBeLessThanOrEqual(2);

    // The idempotent early-return means no second escalation_triggered INSERT.
    const triggered = await knex('ownership_history').where({
      entity_id: entity.id,
      action: 'escalation_triggered',
    });
    // At most one — the retrigger path may or may not produce one depending on
    // BFS results; crucially there is NOT an unbounded sequence of them.
    expect(triggered.length).toBeLessThanOrEqual(1);
  });
});

// ─── mid-tx failure injection ──────────
//
// Injects a throw inside the escalation withTransaction via a patched store.
// The patch replaces `withTransaction` so that when the tx callback is invoked,
// `stores.historyStore.appendHistory` throws — simulating a mid-tx DB error
// after `setEntityEscalated` would have run.
// Asserts: rejects, entity status unchanged, no queue rows, no new history rows.

describe('mid-tx failure injection — atomicity regression protection', () => {
  it('rejects; ownership_history IDs identical before/after; entity status unchanged; no queue rows', async () => {
    const { store, knex } = await createStore();
    const entity = await seedEntityRow(knex, { current_status: 'open' });
    await seedProposalRow(knex, entity.id, {
      proposed_owner_ref: 'group:default/team-a',
      status: 'rejected',
      proposal_order: 1,
    });

    const historyBefore = await knex('ownership_history').where({
      entity_id: entity.id,
    });
    const historyIdsBefore = new Set<string>(
      historyBefore.map((r: any) => r.id),
    );
    const queueCountBefore = Number(
      (
        await knex('escalation_queue_entries')
          .where({ entity_id: entity.id })
          .count('id as n')
          .first()
      )?.n ?? 0,
    );

    const catalog = createStandardOrgHierarchy();

    // Intercept the single withTransaction call in Branch 3. Run the callback
    // inside a real tx but swap historyStore.appendHistory to throw, which
    // causes Postgres to roll back the entire tx (setEntityEscalated +
    // appendHistory + insertQueuePlan all revert atomically).
    const realWithTx = store.withTransaction.bind(store);
    let intercepted = false;
    (store as any).withTransaction = async (
      fn: (stores: any) => Promise<any>,
    ) => {
      if (!intercepted) {
        intercepted = true;
        return realWithTx(async (stores: any) => {
          const injected = {
            ...stores,
            historyStore: {
              ...stores.historyStore,
              appendHistory: jest
                .fn()
                .mockRejectedValue(new Error('injected-mid-tx-failure')),
            },
          };
          return fn(injected);
        });
      }
      return realWithTx(fn);
    };

    const svc = buildService(store, catalog);

    try {
      await expect(svc.triggerEscalation(entity.id)).rejects.toThrow(
        /injected-mid-tx-failure/,
      );
    } finally {
      // Restore so subsequent tests using the shared store are unaffected.
      delete (store as any).withTransaction;
    }

    // Entity status must be unchanged.
    const entityRow = await knex('ownership_entities')
      .where({ id: entity.id })
      .first();
    expect(entityRow.current_status).toBe('open');

    // History row IDs must be identical (set-diff proves tx rolled back, not
    // just that count is the same atomicity check).
    const historyAfter = await knex('ownership_history').where({
      entity_id: entity.id,
    });
    const historyIdsAfter = new Set<string>(historyAfter.map((r: any) => r.id));
    for (const id of historyIdsAfter) {
      expect(historyIdsBefore.has(id)).toBe(true);
    }
    expect(historyIdsAfter.size).toBe(historyIdsBefore.size);

    // Queue must still be empty.
    const queueCountAfter = Number(
      (
        await knex('escalation_queue_entries')
          .where({ entity_id: entity.id })
          .count('id as n')
          .first()
      )?.n ?? 0,
    );
    expect(queueCountAfter).toBe(queueCountBefore);
  });
});

// ─── rebuild queue after historical statuses ──────────
//
// The rebuild-queue test in ScannerEscalation.integration.test.ts covers only
// `completed`. The partial UNIQUE WHERE clause
// allows `resolved`/`rejected`/`skipped` rows to coexist. A regression that
// scopes the WHERE to include these statuses would silently break revalidation
// after skipped/rejected entries and still pass that test.

describe('rebuild queue without unique-violation for all terminal statuses', () => {
  const TERMINAL_STATUSES = ['completed', 'rejected', 'skipped'] as const;

  it.each(TERMINAL_STATUSES)(
    'inserts new queued rows without violation when prior rows have status=%s',
    async terminalStatus => {
      const { store, knex } = await createStore();
      const entity = await seedEntityRow(knex, { current_status: 'open' });
      await seedProposalRow(knex, entity.id, {
        proposed_owner_ref: 'group:default/team-a',
        status: 'rejected',
        proposal_order: 1,
      });

      // Pre-existing row at (level=1, position=1) with terminal status
      // must NOT block the new queue insert.
      await seedQueueEntry(knex, entity.id, {
        group_ref: 'group:default/domain-search',
        escalation_level: 1,
        position: 1,
        status: terminalStatus,
      });

      const svc = buildService(store);

      await expect(svc.triggerEscalation(entity.id)).resolves.toBeUndefined();

      const entityRow = await knex('ownership_entities')
        .where({ id: entity.id })
        .first();
      expect(entityRow.current_status).toBe('escalated');

      const activeRows = await knex('escalation_queue_entries')
        .where({ entity_id: entity.id })
        .whereIn('status', ['queued', 'active']);
      expect(activeRows.length).toBeGreaterThan(0);
    },
  );
});

// ─── escalation-reject endpoint does NOT call triggerEscalation ───────
//
// Pins the contract that POST /entities/:id/escalation/reject only calls
// escalationService.escalationReject (which calls advanceQueue internally),
// never escalationTrigger.triggerEscalation. A regression adding a trigger
// call after escalationReject would break this test.

describe('escalation-reject does NOT call triggerEscalation', () => {
  it('POST /entities/:id/escalation/reject succeeds without invoking lazyTrigger.triggerEscalation', async () => {
    const { store, knex } = await createStore();
    const entity = await seedEntityRow(knex, { current_status: 'escalated' });
    // Seed an active queue entry with alice as the resolved actor.
    await seedQueueEntry(knex, entity.id, {
      group_ref: 'group:default/domain-search',
      escalation_level: 1,
      position: 1,
      status: 'active',
      resolved_actor_ref: 'user:default/alice',
    });

    const escalationService = buildService(store);
    const config = buildValidEscalationConfig();
    const lazyTrigger = new LazyEscalationTrigger();
    lazyTrigger.set(escalationService);

    // Spy AFTER wiring so delegation is tracked.
    const triggerSpy = jest.spyOn(lazyTrigger, 'triggerEscalation');

    const logger = mockServices.logger.mock();
    const lifecycleService = new ProposalLifecycleService(
      store,
      logger,
      undefined,
      config,
      lazyTrigger,
    );
    const mockCatalogService = {
      isUserMemberOfGroup: jest.fn().mockResolvedValue(true),
    } as unknown as CatalogService;

    const router = await createRouter({
      httpAuth: mockServices.httpAuth({
        defaultCredentials: mockCredentials.user('user:default/alice'),
      }),
      userInfo: mockServices.userInfo(),
      store,
      lifecycleService,
      scanService: { runScan: jest.fn(), scanEntity: jest.fn() } as any,
      catalogService: mockCatalogService,
      escalationConfig: config,
      escalationService,
      escalationTrigger: lazyTrigger,
      checks: [],
      strategies: [],
    });
    const app = express().use(router).use(mockErrorHandler());

    const res = await request(app)
      .post(`/entities/${entity.id}/escalation/reject`)
      .send({ reason: 'not our domain' });

    expect(res.status).toBe(200);
    expect(triggerSpy).not.toHaveBeenCalled();
  });
});

// ─── TOCTOU silent-fail documenting test ─────────────────────────────
//
// Documents accepted-risk behaviour where ancestors appear post-resolution.
// When processEntity marks an entity `unresolved` because BFS returns [] and
// the catalog later gains ancestors, the entity stays `unresolved` — the
// TRIGGER_IDEMPOTENT_STATUSES guard prevents re-escalation on the next scan.

describe('TOCTOU silent-fail — entity stays unresolved after catalog repair', () => {
  it('documents accepted silent-fail — entity stays unresolved after catalog repair', async () => {
    const { store, knex } = await createStore();
    const entity = await seedEntityRow(knex, { current_status: 'open' });

    const scanId = randomUUID();
    await knex('ownership_scans').insert({ id: scanId });

    const emptyCatalog = createMockCatalog();
    // emptyCatalog has no groups, so walkGroupHierarchy returns [].

    const svc = buildService(store, emptyCatalog);
    await svc.triggerEscalation(entity.id);

    const afterFirstTrigger = await knex('ownership_entities')
      .where({ id: entity.id })
      .first();
    expect(afterFirstTrigger.current_status).toBe('unresolved');

    const repairedCatalog = createStandardOrgHierarchy();
    const svcRepaired = buildService(store, repairedCatalog);

    // Per TRIGGER_IDEMPOTENT_STATUSES, `unresolved` is a no-op — the entity
    // does NOT flip to `escalated` even though ancestors are now available.
    await svcRepaired.triggerEscalation(entity.id);

    const afterSecondTrigger = await knex('ownership_entities')
      .where({ id: entity.id })
      .first();
    // Accepted silent-fail: entity remains unresolved despite catalog repair.
    expect(afterSecondTrigger.current_status).toBe('unresolved');

    // Assert no second `no_candidates_found` was written (idempotent early-return).
    const noCandidatesRows = await knex('ownership_history').where({
      entity_id: entity.id,
      action: 'no_candidates_found',
    });
    expect(noCandidatesRows).toHaveLength(1);
  });
});

// ─── assigned_to follows the escalation actor ───────────────────
//
// assigned_to is "whoever should act next" (types.ts). Once proposals are
// exhausted it must move off the last proposal team to the escalation actor,
// and be cleared when no escalation actor remains.

describe('assigned_to during escalation', () => {
  it('points at the activated escalation actor, not the rejecting team', async () => {
    const { store, knex } = await createStore();
    const entity = await seedEntityRow(knex, { current_status: 'open' });
    await knex('ownership_entities')
      .where({ id: entity.id })
      .update({ assigned_to: 'group:default/team-a' });
    await seedProposalRow(knex, entity.id, {
      proposed_owner_ref: 'group:default/team-a',
      status: 'rejected',
      proposal_order: 1,
    });
    const svc = buildService(store);

    await svc.triggerEscalation(entity.id);

    const active = await knex('escalation_queue_entries')
      .where({ entity_id: entity.id, status: 'active' })
      .first();
    expect(active?.resolved_actor_ref).toBeTruthy();
    const entityRow = await knex('ownership_entities')
      .where({ id: entity.id })
      .first();
    expect(entityRow.current_status).toBe('escalated');
    expect(entityRow.assigned_to).toBe(active.resolved_actor_ref);
  });

  it('marks the case unresolved with no_escalation_path when the BFS queue is empty', async () => {
    const { store, knex } = await createStore();
    const entity = await seedEntityRow(knex, { current_status: 'open' });
    await knex('ownership_entities')
      .where({ id: entity.id })
      .update({ assigned_to: 'group:default/team-a' });
    await seedProposalRow(knex, entity.id, {
      proposed_owner_ref: 'group:default/team-a',
      status: 'rejected',
      proposal_order: 1,
    });
    // Empty catalog → no live ancestors → empty queue plan.
    const svc = buildService(store, createMockCatalog());

    await svc.triggerEscalation(entity.id);

    const entityRow = await knex('ownership_entities')
      .where({ id: entity.id })
      .first();
    expect(entityRow.current_status).toBe('unresolved');
    expect(entityRow.assigned_to).toBeNull();
    const history = await knex('ownership_history').where({
      entity_id: entity.id,
    });
    expect(history).toEqual([
      expect.objectContaining({
        action: 'escalation_exhausted',
        details: { reason: 'no_escalation_path' },
      }),
    ]);
    const queue = await knex('escalation_queue_entries').where({
      entity_id: entity.id,
    });
    expect(queue).toHaveLength(0);
  });

  it('clears assigned_to when escalation paths are exhausted', async () => {
    const { store, knex } = await createStore();
    const entity = await seedEntityRow(knex, { current_status: 'escalated' });
    await knex('ownership_entities')
      .where({ id: entity.id })
      .update({ assigned_to: 'user:default/director' });
    const svc = buildService(store);

    await store.withTransaction(stores =>
      svc.advanceQueue(stores, entity.id, true),
    );

    const entityRow = await knex('ownership_entities')
      .where({ id: entity.id })
      .first();
    expect(entityRow.current_status).toBe('unresolved');
    expect(entityRow.assigned_to).toBeNull();
  });
});
