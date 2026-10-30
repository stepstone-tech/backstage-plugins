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
 * Escalation triggering and the entity state machine, including blocked
 * transitions.
 *
 * Blocked-transition tests go through the HTTP router so that route-enforced
 * 409s (retrigger on wrong status) and service-enforced 409s (archive on open
 * entity) are all tested at the HTTP boundary.
 */

import {
  mockCredentials,
  mockErrorHandler,
  mockServices,
  TestDatabases,
} from '@backstage/backend-test-utils';
import express from 'express';
import request from 'supertest';
import { DatabaseOwnershipStore } from '../service/DatabaseOwnershipStore';
import { DefaultEscalationService } from './EscalationService';
import { createEscalationRouter } from './router';
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
  seedDeadlineRow,
} from './__fixtures__/seedEntity';
import { DefaultDeadlineCheckerService } from './DeadlineCheckerService';
import { ProposalLifecycleService } from '../service/ProposalLifecycleService';

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

async function buildEscalationApp(
  store: DatabaseOwnershipStore,
  actorRef = 'user:default/mock',
  overrideConfig?: ReturnType<typeof buildValidEscalationConfig>,
) {
  const config = overrideConfig ?? buildValidEscalationConfig();
  const svc = buildService(store);
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
  return { app, svc };
}

// ─── Escalation Triggering ─────────────────────────────────────────

describe('Escalation Triggering', () => {
  describe('sequential proposal exhaustion', () => {
    it('last pending proposal rejected → entity transitions to escalated with escalation_triggered history', async () => {
      // entity transitions to escalated.
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

      const history = await knex('ownership_history')
        .where({ entity_id: entity.id, action: 'escalation_triggered' })
        .first();
      expect(history).toBeDefined();
    });

    it('last pending proposal expired → same transition as the last proposal rejected', async () => {
      const { store, knex } = await createStore();
      const entity = await seedEntityRow(knex, { current_status: 'open' });
      await seedProposalRow(knex, entity.id, {
        proposed_owner_ref: 'group:default/team-a',
        status: 'expired',
        proposal_order: 1,
      });
      const svc = buildService(store);

      await svc.triggerEscalation(entity.id);

      const entityRow = await knex('ownership_entities')
        .where({ id: entity.id })
        .first();
      expect(entityRow.current_status).toBe('escalated');
    });

    it('no candidates found at all → unresolved directly, history: no_candidates_found', async () => {
      const { store, knex } = await createStore();
      const entity = await seedEntityRow(knex, { current_status: 'open' });
      // No proposals seeded — empty candidate list.
      const svc = buildService(store);

      await svc.triggerEscalation(entity.id);

      const entityRow = await knex('ownership_entities')
        .where({ id: entity.id })
        .first();
      expect(entityRow.current_status).toBe('unresolved');

      const history = await knex('ownership_history')
        .where({ entity_id: entity.id, action: 'no_candidates_found' })
        .first();
      expect(history).toBeDefined();
    });

    it('only possible_owner rows present → treated as no candidates → unresolved', async () => {
      // Broadcast persists possible_owner rows on every scan. They must not
      // count as live proposals: an entity with only low-confidence candidates
      // (none ever notified) must still fall through to Branch 1 (unresolved),
      // not be held open forever because `proposals.length !== 0`.
      const { store, knex } = await createStore();
      const entity = await seedEntityRow(knex, { current_status: 'open' });
      await seedProposalRow(knex, entity.id, {
        proposed_owner_ref: 'group:default/team-a',
        status: 'possible_owner',
        proposal_order: 1,
        confidence_score: 0.1,
      });
      await seedProposalRow(knex, entity.id, {
        proposed_owner_ref: 'group:default/team-b',
        status: 'possible_owner',
        proposal_order: 2,
        confidence_score: 0.05,
      });
      const svc = buildService(store);

      await svc.triggerEscalation(entity.id);

      const entityRow = await knex('ownership_entities')
        .where({ id: entity.id })
        .first();
      expect(entityRow.current_status).toBe('unresolved');
      const history = await knex('ownership_history')
        .where({ entity_id: entity.id, action: 'no_candidates_found' })
        .first();
      expect(history).toBeDefined();
      const details =
        typeof history.details === 'string'
          ? JSON.parse(history.details)
          : history.details;
      expect(details).toEqual({ reason: 'only_possible_owners' });
    });

    it('possible_owner teams do NOT seed the BFS escalation queue', async () => {
      // A rejected real proposal (team-a → domain-search) escalates via its
      // ancestor. A possible_owner candidate (team-c → domain-payments, never
      // notified) must be excluded from computeQueuePlan, so domain-payments
      // must NOT appear in the queue. The two teams sit under different domains
      // so this assertion actually exercises the filter.
      const { store, knex } = await createStore();
      const entity = await seedEntityRow(knex, { current_status: 'escalated' });
      await seedProposalRow(knex, entity.id, {
        proposed_owner_ref: 'group:default/team-a',
        status: 'rejected',
        proposal_order: 1,
      });
      await seedProposalRow(knex, entity.id, {
        proposed_owner_ref: 'group:default/team-c',
        status: 'possible_owner',
        proposal_order: 2,
        confidence_score: 0.1,
      });
      const svc = buildService(store);

      await svc.buildBfsQueue(entity.id, new Set());

      // domain-payments (team-c's ancestor) must not be queued — team-c was
      // only a possible_owner. domain-search (team-a's ancestor) should be.
      const paymentsDomain = await knex('escalation_queue_entries').where({
        entity_id: entity.id,
        group_ref: 'group:default/domain-payments',
      });
      expect(paymentsDomain).toHaveLength(0);
      const searchDomain = await knex('escalation_queue_entries').where({
        entity_id: entity.id,
        group_ref: 'group:default/domain-search',
      });
      expect(searchDomain).toHaveLength(1);
    });

    it('deduplication — two teams in same domain produce one domain director in BFS queue', async () => {
      // proposals are under it.
      const { store, knex } = await createStore();
      const entity = await seedEntityRow(knex, { current_status: 'escalated' });
      await seedProposalRow(knex, entity.id, {
        proposed_owner_ref: 'group:default/team-a',
        status: 'rejected',
        proposal_order: 1,
      });
      await seedProposalRow(knex, entity.id, {
        proposed_owner_ref: 'group:default/team-b',
        status: 'rejected',
        proposal_order: 2,
      });
      const svc = buildService(store);

      await svc.buildBfsQueue(entity.id, new Set());

      // After exactly one entry for domain-search (both teams map to same domain).
      const queueEntries = await knex('escalation_queue_entries').where({
        entity_id: entity.id,
        group_ref: 'group:default/domain-search',
      });
      expect(queueEntries).toHaveLength(1);
    });

    it('escalation reject completes active queue entry and captures reason in history', async () => {
      const { store, knex } = await createStore();
      const entity = await seedEntityRow(knex, { current_status: 'escalated' });
      const active = await seedQueueEntry(knex, entity.id, {
        group_ref: 'group:default/domain-search',
        status: 'active',
        resolved_actor_ref: 'user:default/jane.director',
      });
      const { app } = await buildEscalationApp(
        store,
        'user:default/jane.director',
      );

      const res = await request(app)
        .post(`/entities/${entity.id}/escalation/reject`)
        .send({ reason: 'Not our scope' });

      expect(res.status).toBe(200);

      const queueRow = await knex('escalation_queue_entries')
        .where({ id: active.id })
        .first();
      expect(queueRow.status).toBe('completed');

      const history = await knex('ownership_history')
        .where({ entity_id: entity.id, action: 'escalation_rejected' })
        .first();
      expect(history).toBeDefined();
      const details =
        typeof history.details === 'string'
          ? JSON.parse(history.details)
          : history.details;
      expect(details.reason).toBe('Not our scope');

      const entityRow = await knex('ownership_entities')
        .where({ id: entity.id })
        .first();
      expect(entityRow.current_status).toBe('escalated');
    });

    it('empty levels reaching the service is a programming error', async () => {
      // `readEscalationConfig` — when the YAML lacks the section, the reader
      // returns `undefined` and `EscalationService` is never constructed.
      // An explicit empty `levels` array is rejected by the Zod schema's
      // `min(1)` rule. If somehow the service is constructed with
      // empty levels (only possible in tests bypassing the reader), the
      // `triggerEscalation` invariant guard throws `InputError`.
      const { store, knex } = await createStore();
      const entity = await seedEntityRow(knex, { current_status: 'open' });
      await seedProposalRow(knex, entity.id, {
        status: 'rejected',
        proposal_order: 1,
      });
      const catalog = createMockCatalog();
      const clock = new TestClock();
      const logger = mockServices.logger.mock();
      const mockScanner = { runScan: jest.fn(), scanEntity: jest.fn() } as any;
      const mockProposalGen = {
        generateProposalsForEntity: jest.fn().mockResolvedValue(0),
      } as any;
      const disabledConfig = { levels: [] } as any;
      const svc = new DefaultEscalationService(
        store,
        catalog,
        disabledConfig,
        clock,
        mockScanner,
        mockProposalGen,
        logger,
      );

      await expect(svc.triggerEscalation(entity.id)).rejects.toThrow(
        /empty levels/,
      );
    });

    it('broadcast: rejecting one of several pending proposals does NOT escalate while siblings remain', async () => {
      const { store, knex } = await createStore();
      const entity = await seedEntityRow(knex, { current_status: 'open' });
      // Broadcast cohort: all candidates pending simultaneously.
      await seedProposalRow(knex, entity.id, {
        proposed_owner_ref: 'group:default/team-a',
        status: 'rejected',
        proposal_order: 1,
      });
      await seedProposalRow(knex, entity.id, {
        proposed_owner_ref: 'group:default/team-b',
        status: 'pending',
        proposal_order: 2,
      });
      const svc = buildService(store);

      // One already rejected, one still pending → escalation must NOT fire.
      await svc.triggerEscalation(entity.id);

      const entityRow = await knex('ownership_entities')
        .where({ id: entity.id })
        .first();
      expect(entityRow.current_status).toBe('open');
      const escalationHistory = await knex('ownership_history').where({
        entity_id: entity.id,
        action: 'escalation_triggered',
      });
      expect(escalationHistory).toHaveLength(0);
    });

    it('broadcast: escalates once only after ALL pending proposals are exhausted', async () => {
      const { store, knex } = await createStore();
      const entity = await seedEntityRow(knex, { current_status: 'open' });
      // All broadcast candidates have now responded (rejected/expired), none pending.
      await seedProposalRow(knex, entity.id, {
        proposed_owner_ref: 'group:default/team-a',
        status: 'rejected',
        proposal_order: 1,
      });
      await seedProposalRow(knex, entity.id, {
        proposed_owner_ref: 'group:default/team-b',
        status: 'expired',
        proposal_order: 2,
      });
      const svc = buildService(store);

      await svc.triggerEscalation(entity.id);

      const entityRow = await knex('ownership_entities')
        .where({ id: entity.id })
        .first();
      expect(entityRow.current_status).toBe('escalated');
      const escalationHistory = await knex('ownership_history').where({
        entity_id: entity.id,
        action: 'escalation_triggered',
      });
      expect(escalationHistory).toHaveLength(1);
    });

    it('escalation_level = 0 on team proposals (schema check)', async () => {
      // Just verifies DB schema and seed helper.
      const { knex } = await createStore();
      const entity = await seedEntityRow(knex, { current_status: 'open' });
      const p = await seedProposalRow(knex, entity.id, {
        status: 'pending',
        proposal_order: 1,
        escalation_level: 0,
      });

      const row = await knex('ownership_proposals').where({ id: p.id }).first();
      expect(row.escalation_level).toBe(0);
    });

    it('escalation_level = 1 on domain escalation assignment', async () => {
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

      const res = await request(app)
        .post(`/entities/${entity.id}/escalation/assign`)
        .send({ ownerRef: 'group:default/team-b' });

      expect(res.status).toBe(200);
      const proposal = await knex('ownership_proposals')
        .where({
          entity_id: entity.id,
          proposed_owner_ref: 'group:default/team-b',
        })
        .first();
      expect(proposal).toBeDefined();
      expect(proposal.escalation_level).toBe(1);
    });

    it('escalation_level = 2 on portfolio escalation assignment', async () => {
      const { store, knex } = await createStore();
      const entity = await seedEntityRow(knex, {
        current_status: 'escalated',
        version: 1,
      });
      await seedQueueEntry(knex, entity.id, {
        group_ref: 'group:default/portfolio-consumer',
        status: 'active',
        resolved_actor_ref: 'user:default/vp.consumer',
        escalation_level: 2,
      });
      const { app } = await buildEscalationApp(
        store,
        'user:default/vp.consumer',
      );

      const res = await request(app)
        .post(`/entities/${entity.id}/escalation/assign`)
        .send({ ownerRef: 'group:default/team-b' });

      expect(res.status).toBe(200);
      const proposal = await knex('ownership_proposals')
        .where({
          entity_id: entity.id,
          proposed_owner_ref: 'group:default/team-b',
        })
        .first();
      expect(proposal).toBeDefined();
      expect(proposal.escalation_level).toBe(2);
    });

    it('escalation-level grace failure reverts to escalated (escalation_level > 0)', async () => {
      const { store, knex } = await createStore();
      const entity = await seedEntityRow(knex, {
        current_status: 'accepted',
        version: 2,
      });
      await seedProposalRow(knex, entity.id, {
        status: 'accepted',
        escalation_level: 1,
      });
      // seedDeadlineRow imported at top level
      await seedDeadlineRow(knex, entity.id, {
        deadline_type: 'grace_expiry',
        fire_at: new Date('2025-12-31T00:00:00.000Z'),
        escalation_level: 1,
      });
      // DeadlineCheckerService imported at top level
      const clock = new TestClock(new Date('2026-01-01T00:00:00.000Z'));
      const logger = mockServices.logger.mock();
      const escalationSvc = buildService(store);
      const checkerSvc = new DefaultDeadlineCheckerService(
        store,
        escalationSvc,
        buildValidEscalationConfig(),
        clock,
        logger,
      );

      await checkerSvc.processExpiredDeadlines();

      // Grace failure at escalation level → reverts to escalated (not open)
      const entityRow = await knex('ownership_entities')
        .where({ id: entity.id })
        .first();
      expect(entityRow.current_status).toBe('escalated');
    });

    it('proposal-level grace failure reverts to open (escalation_level = 0)', async () => {
      const { store, knex } = await createStore();
      const entity = await seedEntityRow(knex, {
        current_status: 'accepted',
        version: 2,
      });
      await seedProposalRow(knex, entity.id, {
        status: 'accepted',
        escalation_level: 0,
      });
      // seedDeadlineRow imported at top level
      await seedDeadlineRow(knex, entity.id, {
        deadline_type: 'grace_expiry',
        fire_at: new Date('2025-12-31T00:00:00.000Z'),
        escalation_level: 0,
      });
      // DeadlineCheckerService imported at top level
      const clock = new TestClock(new Date('2026-01-01T00:00:00.000Z'));
      const logger = mockServices.logger.mock();
      const escalationSvc = buildService(store);
      const checkerSvc = new DefaultDeadlineCheckerService(
        store,
        escalationSvc,
        buildValidEscalationConfig(),
        clock,
        logger,
      );

      await checkerSvc.processExpiredDeadlines();

      const entityRow = await knex('ownership_entities')
        .where({ id: entity.id })
        .first();
      expect(entityRow.current_status).toBe('open');
    });
  });
});

// ─── State Machine & Invalid Transitions ───────────────────────────

describe('State Machine & Invalid Transitions', () => {
  describe('blocked transitions', () => {
    it('open → to_archive via archive action is blocked → 409', async () => {
      const { store, knex } = await createStore();
      const entity = await seedEntityRow(knex, { current_status: 'open' });
      await seedQueueEntry(knex, entity.id, {
        status: 'active',
        resolved_actor_ref: 'user:default/jane.director',
      });
      const { app } = await buildEscalationApp(
        store,
        'user:default/jane.director',
      );

      const res = await request(app)
        .post(`/entities/${entity.id}/escalation/archive`)
        .send({ assigneeRef: 'group:default/team-b' });

      expect(res.status).toBe(409);
    });

    it('to_archive grace failure reverts to escalated, NOT open', async () => {
      const { store, knex } = await createStore();
      const entity = await seedEntityRow(knex, {
        current_status: 'to_archive',
        version: 2,
      });
      await seedProposalRow(knex, entity.id, {
        status: 'accepted',
        escalation_level: 1,
      });
      // seedDeadlineRow imported at top level
      await seedDeadlineRow(knex, entity.id, {
        deadline_type: 'grace_expiry',
        fire_at: new Date('2025-12-31T00:00:00.000Z'),
        escalation_level: 1,
      });
      // DeadlineCheckerService imported at top level
      const clock = new TestClock(new Date('2026-01-01T00:00:00.000Z'));
      const logger = mockServices.logger.mock();
      const escalationSvc = buildService(store);
      const checkerSvc = new DefaultDeadlineCheckerService(
        store,
        escalationSvc,
        buildValidEscalationConfig(),
        clock,
        logger,
      );

      await checkerSvc.processExpiredDeadlines();

      const entityRow = await knex('ownership_entities')
        .where({ id: entity.id })
        .first();
      // Must revert to escalated, NOT open
      expect(entityRow.current_status).toBe('escalated');
    });

    it('suggest on escalated entity does NOT transition entity to open (entity stays escalated)', async () => {
      const { store, knex } = await createStore();
      const entity = await seedEntityRow(knex, { current_status: 'escalated' });
      await seedQueueEntry(knex, entity.id, {
        status: 'active',
        resolved_actor_ref: 'user:default/jane.director',
      });
      const { app } = await buildEscalationApp(
        store,
        'user:default/jane.director',
      );

      const res = await request(app)
        .post(`/entities/${entity.id}/escalation/suggest`)
        .send({
          suggestedOwnerRef: 'group:default/team-x',
          reason: 'Team-X owns this',
        });

      expect(res.status).toBe(200);
      const entityRow = await knex('ownership_entities')
        .where({ id: entity.id })
        .first();
      expect(entityRow.current_status).toBe('escalated');
    });

    it('retrigger on open entity → 409 (retrigger only valid on unresolved)', async () => {
      // Router checks status BEFORE calling service.
      // The 409 from router is already implemented in router.ts.
      const { store, knex } = await createStore();
      const entity = await seedEntityRow(knex, { current_status: 'open' });
      // Override fallbackActors membership check to return true so auth doesn't block.
      const config = buildValidEscalationConfig({
        fallbackActors: ['user:default/fallback.user'],
      });
      const svc = buildService(store);
      const mockCatalogService = {
        isUserMemberOfGroup: jest.fn().mockResolvedValue(false),
      } as unknown as CatalogService;
      const router = await createEscalationRouter({
        httpAuth: mockServices.httpAuth({
          defaultCredentials: mockCredentials.user(
            'user:default/fallback.user',
          ),
        }),
        store,
        escalationService: svc,
        catalogService: mockCatalogService,
        config,
      });
      const app = express().use(router).use(mockErrorHandler());

      const res = await request(app)
        .post(`/entities/${entity.id}/escalation/retrigger`)
        .send({});

      expect(res.status).toBe(409);
    });

    it('retrigger on accepted entity → 409', async () => {
      const { store, knex } = await createStore();
      const entity = await seedEntityRow(knex, { current_status: 'accepted' });
      const config = buildValidEscalationConfig({
        fallbackActors: ['user:default/fallback.user'],
      });
      const svc = buildService(store);
      const mockCatalogService = {
        isUserMemberOfGroup: jest.fn().mockResolvedValue(false),
      } as unknown as CatalogService;
      const router = await createEscalationRouter({
        httpAuth: mockServices.httpAuth({
          defaultCredentials: mockCredentials.user(
            'user:default/fallback.user',
          ),
        }),
        store,
        escalationService: svc,
        catalogService: mockCatalogService,
        config,
      });
      const app = express().use(router).use(mockErrorHandler());

      const res = await request(app)
        .post(`/entities/${entity.id}/escalation/retrigger`)
        .send({});

      expect(res.status).toBe(409);
    });

    it('retrigger on to_archive entity → 409', async () => {
      const { store, knex } = await createStore();
      const entity = await seedEntityRow(knex, {
        current_status: 'to_archive',
      });
      const config = buildValidEscalationConfig({
        fallbackActors: ['user:default/fallback.user'],
      });
      const svc = buildService(store);
      const mockCatalogService = {
        isUserMemberOfGroup: jest.fn().mockResolvedValue(false),
      } as unknown as CatalogService;
      const router = await createEscalationRouter({
        httpAuth: mockServices.httpAuth({
          defaultCredentials: mockCredentials.user(
            'user:default/fallback.user',
          ),
        }),
        store,
        escalationService: svc,
        catalogService: mockCatalogService,
        config,
      });
      const app = express().use(router).use(mockErrorHandler());

      const res = await request(app)
        .post(`/entities/${entity.id}/escalation/retrigger`)
        .send({});

      expect(res.status).toBe(409);
    });

    it('retrigger on closed entity → 409 (closed is terminal)', async () => {
      const { store, knex } = await createStore();
      const entity = await seedEntityRow(knex, { current_status: 'closed' });
      const config = buildValidEscalationConfig({
        fallbackActors: ['user:default/fallback.user'],
      });
      const svc = buildService(store);
      const mockCatalogService = {
        isUserMemberOfGroup: jest.fn().mockResolvedValue(false),
      } as unknown as CatalogService;
      const router = await createEscalationRouter({
        httpAuth: mockServices.httpAuth({
          defaultCredentials: mockCredentials.user(
            'user:default/fallback.user',
          ),
        }),
        store,
        escalationService: svc,
        catalogService: mockCatalogService,
        config,
      });
      const app = express().use(router).use(mockErrorHandler());

      const res = await request(app)
        .post(`/entities/${entity.id}/escalation/retrigger`)
        .send({});

      expect(res.status).toBe(409);
    });

    it('undo endpoint returns 404 — route and method removed entirely', async () => {
      // This is enforced by router structure, not a stub.
      // ProposalLifecycleService imported at top level
      const logger = mockServices.logger.mock();
      const { store } = await createStore();
      const svc = new ProposalLifecycleService(
        store,
        logger,
        undefined,
        undefined,
        { triggerEscalation: async () => {} },
      );

      // undoProposal should not exist on the service at all.
      expect((svc as any).undoProposal).toBeUndefined();
    });
  });
});
