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
 * Integration tests for the scanner-bypass fix.
 *
 * Uses POSTGRES_16 — the partial UNIQUE on `escalation_queue_entries`
 * requires Postgres semantics that SQLite cannot reproduce.
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
import {
  FallbackEscalationTrigger,
  LazyEscalationTrigger,
} from './EscalationTrigger';
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

// ─── scanner happy path → escalation queue + history ──────────────────
//
// EscalationTriggering.integration.test.ts covers the same status-flip path.
// This adds the scanner-specific assertions: `escalation_queue_entries` populated,
// `pending_deadlines` written by `activateNext`.

describe('scanner happy path', () => {
  it('seeds queue + deadlines + history when proposals are exhausted and BFS resolves', async () => {
    const { store, knex } = await createStore();
    const entity = await seedEntityRow(knex, { current_status: 'open' });
    await seedProposalRow(knex, entity.id, {
      proposed_owner_ref: 'group:default/team-a',
      status: 'rejected',
      proposal_order: 1,
    });
    const svc = buildService(store);

    await svc.triggerEscalation(entity.id);

    const entityRow = await knex('ownership_entities')
      .where({ id: entity.id })
      .first();
    expect(entityRow.current_status).toBe('escalated');

    const queueRows = await knex('escalation_queue_entries').where({
      entity_id: entity.id,
    });
    expect(queueRows.length).toBeGreaterThan(0);

    const timeoutDeadlines = await knex('pending_deadlines').where({
      entity_id: entity.id,
      deadline_type: 'escalation_timeout',
    });
    expect(timeoutDeadlines.length).toBeGreaterThanOrEqual(1);

    const triggered = await knex('ownership_history').where({
      entity_id: entity.id,
      action: 'escalation_triggered',
    });
    expect(triggered).toHaveLength(1);
  });
});

// ─── scanner with no resolvable ancestors → unresolved + no history ───

describe('orphan with no candidates → unresolved', () => {
  it('writes no_candidates_found history, no queue rows, no escalation_triggered', async () => {
    const { store, knex } = await createStore();
    // Seed a stale assignee from a prior cycle to prove Branch 1 actively
    // clears it (MUST-ADDRESS 2). Without the explicit
    // updateAssignee(null) in EscalationService Branch 1, the row would keep
    // 'user:default/alice'. seedEntityRow hard-codes assigned_to=null, so we
    // patch it via knex after insert.
    const entity = await seedEntityRow(knex, { current_status: 'open' });
    await knex('ownership_entities')
      .where({ id: entity.id })
      .update({ assigned_to: 'user:default/alice' });
    // No proposals seeded — Branch 1 path.
    const svc = buildService(store);

    await svc.triggerEscalation(entity.id);

    const entityRow = await knex('ownership_entities')
      .where({ id: entity.id })
      .first();
    expect(entityRow.current_status).toBe('unresolved');
    expect(entityRow.assigned_to).toBeNull();

    const noCandidates = await knex('ownership_history')
      .where({ entity_id: entity.id, action: 'no_candidates_found' })
      .first();
    expect(noCandidates).toBeDefined();

    const triggered = await knex('ownership_history').where({
      entity_id: entity.id,
      action: 'escalation_triggered',
    });
    expect(triggered).toHaveLength(0);

    const queueRows = await knex('escalation_queue_entries').where({
      entity_id: entity.id,
    });
    expect(queueRows).toHaveLength(0);
  });
});

// ─── HTTP reject path → router triggers escalation ────────────────────
//
// The proposal-reject route owns the
// "rejected the last candidate" decision via `EscalationTrigger`, NOT
// `ProposalLifecycleService`.

describe('proposal reject HTTP path → escalation_triggered', () => {
  it('rejecting last pending proposal escalates entity with queue rows', async () => {
    const { store, knex } = await createStore();
    const entity = await seedEntityRow(knex, { current_status: 'open' });
    const proposal = await seedProposalRow(knex, entity.id, {
      proposed_owner_ref: 'group:default/team-a',
      status: 'pending',
      proposal_order: 1,
    });

    const escalationService = buildService(store);
    const config = buildValidEscalationConfig();
    const trigger = new LazyEscalationTrigger();
    trigger.set(escalationService);

    const logger = mockServices.logger.mock();
    const lifecycleService = new ProposalLifecycleService(
      store,
      logger,
      undefined,
      config,
      trigger,
    );
    const mockScanner = {
      runScan: jest.fn(),
      scanEntity: jest.fn(),
    } as any;
    // The proposal route calls `assertUserIsTeamMember`; alice belongs to
    // team-a in the standard org.
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
      scanService: mockScanner,
      catalogService: mockCatalogService,
      escalationConfig: config,
      escalationService,
      escalationTrigger: trigger,
      checks: [],
      strategies: [],
    });
    const app = express().use(router).use(mockErrorHandler());

    const res = await request(app)
      .post(`/proposals/${proposal.id}/reject`)
      .send({ reason: 'not our team' });

    expect(res.status).toBe(200);

    // Pin the contract that the router re-fetches after triggerEscalation
    // (MUST-ADDRESS 3). Without the re-fetch the body would carry
    // the pre-trigger snapshot (`open`) even though the row is `escalated`.
    expect(res.body.entity.current_status).toBe('escalated');

    const entityRow = await knex('ownership_entities')
      .where({ id: entity.id })
      .first();
    expect(entityRow.current_status).toBe('escalated');

    const rejected = await knex('ownership_history').where({
      entity_id: entity.id,
      action: 'proposal_rejected',
    });
    expect(rejected).toHaveLength(1);

    const triggered = await knex('ownership_history').where({
      entity_id: entity.id,
      action: 'escalation_triggered',
    });
    expect(triggered).toHaveLength(1);

    const queueRows = await knex('escalation_queue_entries').where({
      entity_id: entity.id,
    });
    expect(queueRows.length).toBeGreaterThan(0);
  });
});

// ─── Reject leaves another pending proposal → no escalation ───────
//
// When another pending proposal still exists after the reject, escalation
// should NOT fire (router pre-check returns ≥1 active proposal) and the
// entity stays `open`.

describe('reject with another pending proposal does not escalate', () => {
  it('keeps entity open and does not trigger escalation when other proposals remain', async () => {
    const { store, knex } = await createStore();
    const entity = await seedEntityRow(knex, { current_status: 'open' });
    const p1 = await seedProposalRow(knex, entity.id, {
      proposed_owner_ref: 'group:default/team-a',
      status: 'pending',
      proposal_order: 1,
    });
    await seedProposalRow(knex, entity.id, {
      proposed_owner_ref: 'group:default/team-b',
      status: 'pending', // a second pending proposal — `listActiveProposalsByEntity`
      proposal_order: 2, // returns it, so the reject route must skip the trigger.
    });

    const escalationService = buildService(store);
    const config = buildValidEscalationConfig();
    const trigger = new LazyEscalationTrigger();
    trigger.set(escalationService);

    const logger = mockServices.logger.mock();
    const lifecycleService = new ProposalLifecycleService(
      store,
      logger,
      undefined,
      config,
      trigger,
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
      escalationTrigger: trigger,
      checks: [],
      strategies: [],
    });
    const app = express().use(router).use(mockErrorHandler());

    const res = await request(app)
      .post(`/proposals/${p1.id}/reject`)
      .send({ reason: 'not our team' });

    expect(res.status).toBe(200);

    const entityRow = await knex('ownership_entities')
      .where({ id: entity.id })
      .first();
    expect(entityRow.current_status).toBe('open');

    const triggered = await knex('ownership_history').where({
      entity_id: entity.id,
      action: 'escalation_triggered',
    });
    expect(triggered).toHaveLength(0);

    const queueRows = await knex('escalation_queue_entries').where({
      entity_id: entity.id,
    });
    expect(queueRows).toHaveLength(0);
  });
});

// ─── serial idempotency ───────────────────────────────────────────────

describe('serial re-trigger on already-escalated entity', () => {
  it('second triggerEscalation is a no-op — no duplicate queue rows or history', async () => {
    const { store, knex } = await createStore();
    const entity = await seedEntityRow(knex, { current_status: 'open' });
    await seedProposalRow(knex, entity.id, {
      proposed_owner_ref: 'group:default/team-a',
      status: 'rejected',
      proposal_order: 1,
    });
    const svc = buildService(store);

    await svc.triggerEscalation(entity.id);
    const queueAfter1 = await knex('escalation_queue_entries').where({
      entity_id: entity.id,
    });
    const triggeredAfter1 = await knex('ownership_history').where({
      entity_id: entity.id,
      action: 'escalation_triggered',
    });

    await svc.triggerEscalation(entity.id);
    const queueAfter2 = await knex('escalation_queue_entries').where({
      entity_id: entity.id,
    });
    const triggeredAfter2 = await knex('ownership_history').where({
      entity_id: entity.id,
      action: 'escalation_triggered',
    });

    expect(queueAfter2).toHaveLength(queueAfter1.length);
    expect(triggeredAfter2).toHaveLength(triggeredAfter1.length);
    expect(triggeredAfter2).toHaveLength(1);
    const details =
      typeof triggeredAfter2[0].details === 'string'
        ? JSON.parse(triggeredAfter2[0].details)
        : triggeredAfter2[0].details;
    expect(details.reason).toBe('candidates_exhausted');
  });
});

// ─── concurrent triggers — partial UNIQUE prevents dup rows ───────────

describe('concurrent triggerEscalation', () => {
  it('two parallel triggers produce exactly one queue row per (level, position)', async () => {
    const { store, knex } = await createStore();
    const entity = await seedEntityRow(knex, { current_status: 'open' });
    await seedProposalRow(knex, entity.id, {
      proposed_owner_ref: 'group:default/team-a',
      status: 'rejected',
      proposal_order: 1,
    });
    const svc = buildService(store);

    await Promise.all([
      svc.triggerEscalation(entity.id),
      svc.triggerEscalation(entity.id),
    ]);

    // Per `(escalation_level, position)`: exactly one active row.
    const rows = await knex('escalation_queue_entries')
      .where({ entity_id: entity.id })
      .whereIn('status', ['queued', 'active']);
    const seen = new Set<string>();
    for (const r of rows) {
      const key = `${r.escalation_level}:${r.position}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }

    const triggered = await knex('ownership_history').where({
      entity_id: entity.id,
      action: 'escalation_triggered',
    });
    expect(triggered).toHaveLength(1);
  });
});

// ─── disabled escalation (FallbackEscalationTrigger) HTTP path ────────

describe('disabled escalation → fallback trigger writes unresolved', () => {
  it('rejecting the last pending proposal flips entity to unresolved', async () => {
    const { store, knex } = await createStore();
    const entity = await seedEntityRow(knex, { current_status: 'open' });
    const proposal = await seedProposalRow(knex, entity.id, {
      proposed_owner_ref: 'group:default/team-a',
      status: 'pending',
      proposal_order: 1,
    });

    const logger = mockServices.logger.mock();
    // Simulate plugin.ts wiring with no escalation config — fallback trigger.
    const trigger = new FallbackEscalationTrigger(store, logger);
    const lifecycleService = new ProposalLifecycleService(
      store,
      logger,
      undefined,
      undefined,
      trigger,
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
      // escalationConfig + escalationService omitted → escalation router not mounted.
      escalationTrigger: trigger,
      checks: [],
      strategies: [],
    });
    const app = express().use(router).use(mockErrorHandler());

    const res = await request(app)
      .post(`/proposals/${proposal.id}/reject`)
      .send({ reason: 'not our team' });

    expect(res.status).toBe(200);

    const entityRow = await knex('ownership_entities')
      .where({ id: entity.id })
      .first();
    expect(entityRow.current_status).toBe('unresolved');
    expect(entityRow.assigned_to).toBeNull();

    const noCandidates = await knex('ownership_history')
      .where({ entity_id: entity.id, action: 'no_candidates_found' })
      .first();
    expect(noCandidates).toBeDefined();
    const details =
      typeof noCandidates.details === 'string'
        ? JSON.parse(noCandidates.details)
        : noCandidates.details;
    expect(details.reason).toBe('escalation_disabled');

    const triggered = await knex('ownership_history').where({
      entity_id: entity.id,
      action: 'escalation_triggered',
    });
    expect(triggered).toHaveLength(0);

    const queueRows = await knex('escalation_queue_entries').where({
      entity_id: entity.id,
    });
    expect(queueRows).toHaveLength(0);
  });
});

// ─── fallback won't demote escalated entity ───────────────────────────

describe('FallbackEscalationTrigger preserves escalated state', () => {
  it('does not flip an already-escalated entity to unresolved', async () => {
    const { store, knex } = await createStore();
    const entity = await seedEntityRow(knex, { current_status: 'escalated' });
    await seedQueueEntry(knex, entity.id, {
      group_ref: 'group:default/domain-search',
      status: 'active',
      resolved_actor_ref: 'user:default/jane.director',
    });
    const logger = mockServices.logger.mock();
    const trigger = new FallbackEscalationTrigger(store, logger);

    await trigger.triggerEscalation(entity.id);

    const entityRow = await knex('ownership_entities')
      .where({ id: entity.id })
      .first();
    expect(entityRow.current_status).toBe('escalated');

    const queueRows = await knex('escalation_queue_entries').where({
      entity_id: entity.id,
    });
    expect(queueRows).toHaveLength(1);
    expect(queueRows[0].status).toBe('active');

    const unresolvedHistory = await knex('ownership_history').where({
      entity_id: entity.id,
      action: 'no_candidates_found',
    });
    expect(unresolvedHistory).toHaveLength(0);
  });
});

// ─── lazy holder programming-error guard via EPS ──────────────────────

describe('LazyEscalationTrigger before set() throws via EPS', () => {
  it('throws "before wiring complete" when generateProposals returns false and trigger is unset', async () => {
    const { store, knex } = await createStore();

    const scanId = randomUUID();
    await knex('ownership_scans').insert({ id: scanId });

    const lazy = new LazyEscalationTrigger();
    const logger = mockServices.logger.mock();
    const scmRegistry = {
      repoFor: jest.fn().mockResolvedValue(undefined),
    } as unknown as ScmRegistry;
    const proposalGenerationService = {
      generateProposals: jest.fn().mockResolvedValue(false),
    } as unknown as ProposalGenerationService;

    const eps = new EntityProcessingService(
      scmRegistry,
      proposalGenerationService,
      store,
      [orphanedCheck],
      new Set(['orphaned']),
      logger,
      undefined,
      lazy,
      {
        getEntityByRef: jest.fn().mockResolvedValue(undefined),
      } as unknown as CatalogService,
    );

    const entity: CatalogComponent = {
      kind: 'Component',
      metadata: { name: `svc-${Date.now()}`, namespace: 'default' },
      spec: {},
    };

    await expect(
      eps.processEntity(entity, {} as OwnershipCheckContext, scanId, {
        ...emptyStats,
      }),
    ).rejects.toThrow(/before wiring complete/);
  });
});

// ─── catalog HTTP failure → entity stays open, no partial state ──────

describe('catalog HTTP failure during BFS', () => {
  it('triggerEscalation rejects and DB state is untouched', async () => {
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

    // Catalog throws on the first HTTP call, which `computeQueuePlan` makes
    // before any tx is opened (HTTP-out-of-tx).
    const failingCatalog = createMockCatalog();
    failingCatalog.walkGroupHierarchy = jest
      .fn()
      .mockRejectedValue(new Error('catalog 503'));

    const svc = buildService(store, failingCatalog);

    await expect(svc.triggerEscalation(entity.id)).rejects.toThrow(
      /catalog 503/,
    );

    const entityRow = await knex('ownership_entities')
      .where({ id: entity.id })
      .first();
    expect(entityRow.current_status).toBe('open');

    const queueRows = await knex('escalation_queue_entries').where({
      entity_id: entity.id,
    });
    expect(queueRows).toHaveLength(0);

    const triggered = await knex('ownership_history').where({
      entity_id: entity.id,
      action: 'escalation_triggered',
    });
    expect(triggered).toHaveLength(0);

    const historyAfter = await knex('ownership_history').where({
      entity_id: entity.id,
    });
    expect(historyAfter.length).toBe(historyBefore.length);
  });

  it('Branch 1 (no proposals) does not call walkGroupHierarchy', async () => {
    // Branch 1 should be a pure DB transition — any new HTTP read here is a
    // regression that risks (HTTP inside withTransaction) all over
    // again. Pin the contract by asserting the catalog stays untouched.
    const { store, knex } = await createStore();
    const entity = await seedEntityRow(knex, { current_status: 'open' });
    // No proposals seeded — Branch 1 path.

    const catalog = createMockCatalog();
    const walkSpy = jest.fn().mockResolvedValue([]);
    catalog.walkGroupHierarchy = walkSpy;
    const svc = buildService(store, catalog);

    await svc.triggerEscalation(entity.id);

    expect(walkSpy).not.toHaveBeenCalled();

    const entityRow = await knex('ownership_entities')
      .where({ id: entity.id })
      .first();
    expect(entityRow.current_status).toBe('unresolved');
  });
});

// ─── re-trigger after fully-exhausted previous run ───────────────────
//
// Partial UNIQUE only covers `status IN ('queued','active')` — `completed` /
// `cancelled` rows must NOT block reinsertion when the queue is rebuilt.

describe('rebuild queue after previous queue resolved', () => {
  it('inserts new queued rows without unique-violation when prior rows are completed', async () => {
    const { store, knex } = await createStore();
    const entity = await seedEntityRow(knex, { current_status: 'open' });
    await seedProposalRow(knex, entity.id, {
      proposed_owner_ref: 'group:default/team-a',
      status: 'rejected',
      proposal_order: 1,
    });

    // Pre-existing resolved rows at (level=1, position=1) — these must NOT
    // block the new queue insert.
    await seedQueueEntry(knex, entity.id, {
      group_ref: 'group:default/domain-search',
      escalation_level: 1,
      position: 1,
      status: 'completed',
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
  });
});
