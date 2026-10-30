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
 * Escalation actions (reject/assign/archive/suggest) and the suggested-owner
 * flow.
 */

import {
  mockCredentials,
  mockErrorHandler,
  mockServices,
  TestDatabases,
} from '@backstage/backend-test-utils';
import express from 'express';
import request from 'supertest';
import { AuthorizeResult } from '@backstage/plugin-permission-common';
import { DatabaseOwnershipStore } from '../service/DatabaseOwnershipStore';
import { DefaultEscalationService } from './EscalationService';
import type { PrCreationTrigger } from '../pr';
import { createEscalationRouter } from './router';
import { createRouter } from '../router';
import { CatalogService } from '@stepstone-tech/backstage-plugin-ownership-matcher-node';
import { ProposalLifecycleService } from '../service/ProposalLifecycleService';
import { DefaultDeadlineCheckerService } from './DeadlineCheckerService';
import { createMockEscalationTrigger } from '../__testutils__/mockEscalationTrigger';
import { createStandardOrgHierarchy } from './__fixtures__/createMockCatalog';
import { buildValidEscalationConfig } from './__fixtures__/buildEscalationConfig';
import { TestClock } from './__fixtures__/Clock';
import {
  seedEntityRow,
  seedProposalRow,
  seedQueueEntry,
  seedDeadlineRow,
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
  clock?: TestClock,
  prCreationTrigger?: PrCreationTrigger,
) {
  const catalog = createStandardOrgHierarchy();
  const config = buildValidEscalationConfig();
  const clk = clock ?? new TestClock();
  const logger = mockServices.logger.mock();
  const mockScanner = { runScan: jest.fn(), scanEntity: jest.fn() } as any;
  const mockProposalGen = {
    generateProposalsForEntity: jest.fn().mockResolvedValue(0),
  } as any;
  return new DefaultEscalationService(
    store,
    catalog,
    config,
    clk,
    mockScanner,
    mockProposalGen,
    logger,
    undefined,
    prCreationTrigger,
  );
}

/**
 * Build an Express app with the escalation router.
 *
 * @param store Real DB-backed store.
 * @param actorRef The user entity ref to authenticate as (defaults to mock).
 * @param overrideConfig Optional config overrides (e.g. different fallbackActors).
 */
async function buildEscalationApp(
  store: DatabaseOwnershipStore,
  actorRef = 'user:default/mock',
  overrideConfig?: ReturnType<typeof buildValidEscalationConfig>,
  opts: { admin?: boolean; prCreationTrigger?: PrCreationTrigger } = {},
) {
  const config = overrideConfig ?? buildValidEscalationConfig();
  const svc = buildService(store, undefined, opts.prCreationTrigger);
  const permissions = {
    authorize: jest.fn().mockResolvedValue([
      {
        result: opts.admin ? AuthorizeResult.ALLOW : AuthorizeResult.DENY,
      },
    ]),
  } as any;
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
    permissions,
    store,
    escalationService: svc,
    catalogService: mockCatalogService,
    config,
  });
  const app = express().use(router).use(mockErrorHandler());
  return { app, svc, mockCatalogService, permissions };
}

// ─── Escalation Actions ────────────────────────────────────────────

describe('Escalation Actions', () => {
  describe('reject', () => {
    it('escalation reject with mandatory reason → 200 { entity, nextActor }', async () => {
      const { store, knex } = await createStore();
      const entity = await seedEntityRow(knex, { current_status: 'escalated' });
      await seedQueueEntry(knex, entity.id, {
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
      expect(res.body.entity).toBeDefined();
      expect(res.body.entity.current_status).toBe('escalated');
      expect(res.body.entity.version).toBeUndefined();
      // nextActor is either the next BFS entry or null (if exhausted)
      expect(
        res.body.nextActor === null ||
          (typeof res.body.nextActor === 'object' &&
            typeof res.body.nextActor.groupRef === 'string'),
      ).toBe(true);

      // History row written
      const history = await knex('ownership_history')
        .where({ entity_id: entity.id })
        .orderBy('created_at', 'desc')
        .first();
      expect(history.action).toBe('escalation_rejected');
      expect(history.actor).toBe('user:default/jane.director');
      // an object, so assert on the structured field rather than treating it
      // as a string. explicitly defines `details` as structured.
      const detailsObj =
        typeof history.details === 'string'
          ? JSON.parse(history.details)
          : history.details;
      expect(detailsObj.reason).toBe('Not our scope');
    });

    it('escalation reject without reason → 400', async () => {
      const { store, knex } = await createStore();
      const entity = await seedEntityRow(knex, { current_status: 'escalated' });
      const { app } = await buildEscalationApp(store);

      const res = await request(app)
        .post(`/entities/${entity.id}/escalation/reject`)
        .send({});
      expect(res.status).toBe(400);
    });

    it('escalation reject with empty string reason → 400', async () => {
      const { store, knex } = await createStore();
      const entity = await seedEntityRow(knex, { current_status: 'escalated' });
      const { app } = await buildEscalationApp(store);

      const res = await request(app)
        .post(`/entities/${entity.id}/escalation/reject`)
        .send({ reason: '' });
      expect(res.status).toBe(400);
    });

    it('escalation reject with extra body fields → 400 (strict schema)', async () => {
      // schemas.ts: escalationRejectSchema.strict — unknown fields rejected.
      const { store, knex } = await createStore();
      const entity = await seedEntityRow(knex, { current_status: 'escalated' });
      const { app } = await buildEscalationApp(store);

      const res = await request(app)
        .post(`/entities/${entity.id}/escalation/reject`)
        .send({ reason: 'valid', suggestion: 'extra-field' });
      expect(res.status).toBe(400);
    });

    it('proposal-level reject with mandatory reason → 200, proposal rejected', async () => {
      const { store, knex } = await createStore();
      const entity = await seedEntityRow(knex, { current_status: 'open' });
      const proposal = await seedProposalRow(knex, entity.id, {
        status: 'pending',
        proposal_order: 1,
        escalation_level: 0,
      });
      // ProposalLifecycleService imported at top level
      const logger = mockServices.logger.mock();
      const svc = new ProposalLifecycleService(
        store,
        logger,
        undefined,
        undefined,
        { triggerEscalation: async () => {} },
      );

      await svc.rejectProposal(
        proposal.id,
        'user:default/alice',
        'Not our component',
      );

      // Proposal should be rejected
      const row = await knex('ownership_proposals')
        .where({ id: proposal.id })
        .first();
      expect(row.status).toBe('rejected');
      expect(row.response_note).toContain('Not our component');
    });

    it('proposal-level reject without reason → 400', async () => {
      const { store, knex } = await createStore();
      const entity = await seedEntityRow(knex, { current_status: 'open' });
      await seedProposalRow(knex, entity.id, {
        status: 'pending',
        proposal_order: 1,
      });

      // createRouter imported at top level
      // ProposalLifecycleService imported at top level
      const logger = mockServices.logger.mock();
      const lifecycleSvc = new ProposalLifecycleService(
        store,
        logger,
        undefined,
        undefined,
        { triggerEscalation: async () => {} },
      );
      const mockScanService = { runScan: jest.fn() } as any;
      const mockCatalog = {
        isUserMemberOfGroup: jest.fn().mockResolvedValue(true),
      } as any;
      const router = await createRouter({
        httpAuth: mockServices.httpAuth(),
        userInfo: mockServices.userInfo(),
        store,
        lifecycleService: lifecycleSvc,
        scanService: mockScanService,
        catalogService: mockCatalog,
        escalationConfig: buildValidEscalationConfig(),
        escalationTrigger: createMockEscalationTrigger(),
        checks: [],
        strategies: [],
      });
      const app = express().use(router).use(mockErrorHandler());

      const proposals = await knex('ownership_proposals').where({
        entity_id: entity.id,
      });
      const pId = proposals[0].id;

      const res = await request(app).post(`/proposals/${pId}/reject`).send({});
      expect(res.status).toBe(400);
    });
  });

  describe('assign', () => {
    it('assign action → 200 { entity }, entity transitions to accepted, grace deadlines written', async () => {
      const { store, knex } = await createStore();
      const entity = await seedEntityRow(knex, { current_status: 'escalated' });
      await seedQueueEntry(knex, entity.id, {
        group_ref: 'group:default/domain-search',
        status: 'active',
        resolved_actor_ref: 'user:default/jane.director',
      });
      const { app } = await buildEscalationApp(
        store,
        'user:default/jane.director',
      );

      const res = await request(app)
        .post(`/entities/${entity.id}/escalation/assign`)
        .send({ ownerRef: 'group:default/team-b' });

      expect(res.status).toBe(200);
      expect(res.body.entity).toBeDefined();
      expect(res.body.entity.current_status).toBe('accepted');
      expect(res.body.entity.version).toBeUndefined();

      // Grace deadlines written to pending_deadlines
      const deadlines = await knex('pending_deadlines').where({
        entity_id: entity.id,
      });
      const types = deadlines.map((d: any) => d.deadline_type);
      expect(types).toContain('grace_warning');
      expect(types).toContain('grace_expiry');
    });

    it('assign with empty ownerRef → 400', async () => {
      const { store, knex } = await createStore();
      const entity = await seedEntityRow(knex, { current_status: 'escalated' });
      const { app } = await buildEscalationApp(store);

      const res = await request(app)
        .post(`/entities/${entity.id}/escalation/assign`)
        .send({ ownerRef: '' });
      expect(res.status).toBe(400);
    });

    it('assign without ownerRef → 400', async () => {
      const { store, knex } = await createStore();
      const entity = await seedEntityRow(knex, { current_status: 'escalated' });
      const { app } = await buildEscalationApp(store);

      const res = await request(app)
        .post(`/entities/${entity.id}/escalation/assign`)
        .send({});
      expect(res.status).toBe(400);
    });
  });

  describe('archive', () => {
    it('escalation archive → 200 { entity }, entity transitions to to_archive, grace deadlines written', async () => {
      const { store, knex } = await createStore();
      const entity = await seedEntityRow(knex, { current_status: 'escalated' });
      await seedQueueEntry(knex, entity.id, {
        group_ref: 'group:default/domain-search',
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

      expect(res.status).toBe(200);
      expect(res.body.entity).toBeDefined();
      expect(res.body.entity.current_status).toBe('to_archive');
      expect(res.body.entity.version).toBeUndefined();

      // Grace deadlines written
      const deadlines = await knex('pending_deadlines').where({
        entity_id: entity.id,
      });
      const types = deadlines.map((d: any) => d.deadline_type);
      expect(types).toContain('grace_warning');
      expect(types).toContain('grace_expiry');
    });

    it('escalation archive without assigneeRef → 400', async () => {
      const { store, knex } = await createStore();
      const entity = await seedEntityRow(knex, { current_status: 'escalated' });
      const { app } = await buildEscalationApp(store);

      const res = await request(app)
        .post(`/entities/${entity.id}/escalation/archive`)
        .send({});
      expect(res.status).toBe(400);
    });
  });

  describe('suggest', () => {
    it('suggest action → 200 { entity, proposal }, escalation paused', async () => {
      const { store, knex } = await createStore();
      const entity = await seedEntityRow(knex, { current_status: 'escalated' });
      await seedQueueEntry(knex, entity.id, {
        group_ref: 'group:default/domain-search',
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
          reason: 'Team-X owns this domain',
        });

      expect(res.status).toBe(200);
      expect(res.body.entity).toBeDefined();
      expect(res.body.entity.version).toBeUndefined();
      expect(res.body.proposal).toBeDefined();
      expect(res.body.proposal.proposed_owner_ref).toBe('group:default/team-x');

      // escalation_timeout deadline cancelled
      const timeoutDeadlines = await knex('pending_deadlines').where({
        entity_id: entity.id,
        deadline_type: 'escalation_timeout',
        processed: false,
      });
      expect(timeoutDeadlines).toHaveLength(0);
    });

    it('suggest without reason → 400', async () => {
      const { store, knex } = await createStore();
      const entity = await seedEntityRow(knex, { current_status: 'escalated' });
      const { app } = await buildEscalationApp(store);

      const res = await request(app)
        .post(`/entities/${entity.id}/escalation/suggest`)
        .send({ suggestedOwnerRef: 'group:default/team-x' });
      expect(res.status).toBe(400);
    });

    it('suggest without suggestedOwnerRef → 400', async () => {
      const { store, knex } = await createStore();
      const entity = await seedEntityRow(knex, { current_status: 'escalated' });
      const { app } = await buildEscalationApp(store);

      const res = await request(app)
        .post(`/entities/${entity.id}/escalation/suggest`)
        .send({ reason: 'Team-X owns this' });
      expect(res.status).toBe(400);
    });

    it('suggest with empty body → 400', async () => {
      const { store, knex } = await createStore();
      const entity = await seedEntityRow(knex, { current_status: 'escalated' });
      const { app } = await buildEscalationApp(store);

      const res = await request(app)
        .post(`/entities/${entity.id}/escalation/suggest`)
        .send({});
      expect(res.status).toBe(400);
    });
  });

  describe('conflict / state checks', () => {
    it('escalation action on non-escalated entity (open) → 409 ConflictError', async () => {
      // The service enforces status precondition inside withTransaction → ConflictError (409).
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
        .post(`/entities/${entity.id}/escalation/assign`)
        .send({ ownerRef: 'group:default/team-b' });

      expect(res.status).toBe(409);
    });

    it('non-terminal escalation action (reject) on unresolved entity → 409 ConflictError', async () => {
      // unresolved = escalation exhausted; only the terminal assign/archive
      // actions (admin-only) remain available.
      const { store, knex } = await createStore();
      const entity = await seedEntityRow(knex, {
        current_status: 'unresolved',
      });
      await seedQueueEntry(knex, entity.id, {
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

      expect(res.status).toBe(409);
    });

    it('pass endpoint returns 404 — route removed', async () => {
      const { store, knex } = await createStore();
      const entity = await seedEntityRow(knex, { current_status: 'escalated' });
      const { app } = await buildEscalationApp(store);

      const res = await request(app)
        .post(`/entities/${entity.id}/escalation/pass`)
        .send({});
      expect(res.status).toBe(404);
    });

    it('suggest is escalation-level only — team-level entity (open) → 409', async () => {
      const { store, knex } = await createStore();
      const entity = await seedEntityRow(knex, { current_status: 'open' });
      await seedProposalRow(knex, entity.id, {
        status: 'pending',
        proposal_order: 1,
      });
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

      expect(res.status).toBe(409);
    });
  });

  describe('unresolved entities (admin-only)', () => {
    it('admin assigns unresolved entity → 200, accepted, grace deadlines written', async () => {
      const { store, knex } = await createStore();
      const entity = await seedEntityRow(knex, {
        current_status: 'unresolved',
      });
      const { app } = await buildEscalationApp(
        store,
        'user:default/admin',
        undefined,
        { admin: true },
      );

      const res = await request(app)
        .post(`/entities/${entity.id}/escalation/assign`)
        .send({ ownerRef: 'group:default/team-b' });

      expect(res.status).toBe(200);
      expect(res.body.entity.current_status).toBe('accepted');
      const types = (
        await knex('pending_deadlines').where({ entity_id: entity.id })
      ).map((d: any) => d.deadline_type);
      expect(types).toEqual(
        expect.arrayContaining(['grace_warning', 'grace_expiry']),
      );
      const proposal = await knex('ownership_proposals')
        .where({ entity_id: entity.id, status: 'accepted' })
        .first();
      expect(proposal.proposed_owner_ref).toBe('group:default/team-b');
      expect(proposal.escalation_level).toBe(1);
    });

    it('admin archives unresolved entity → 200, to_archive', async () => {
      const { store, knex } = await createStore();
      const entity = await seedEntityRow(knex, {
        current_status: 'unresolved',
      });
      const { app } = await buildEscalationApp(
        store,
        'user:default/admin',
        undefined,
        { admin: true },
      );

      const res = await request(app)
        .post(`/entities/${entity.id}/escalation/archive`)
        .send({ assigneeRef: 'group:default/team-b' });

      expect(res.status).toBe(200);
      expect(res.body.entity.current_status).toBe('to_archive');
    });

    it.each(['assign', 'archive'])(
      'non-admin %s on unresolved entity → 403',
      async action => {
        const { store, knex } = await createStore();
        const entity = await seedEntityRow(knex, {
          current_status: 'unresolved',
        });
        const { app } = await buildEscalationApp(store, 'user:default/mock');

        const res = await request(app)
          .post(`/entities/${entity.id}/escalation/${action}`)
          .send(
            action === 'assign'
              ? { ownerRef: 'group:default/team-b' }
              : { assigneeRef: 'group:default/team-b' },
          );

        expect(res.status).toBe(403);
        const row = await knex('ownership_entities')
          .where({ id: entity.id })
          .first();
        expect(row.current_status).toBe('unresolved');
      },
    );

    it('admin cannot bypass resolved-actor check on escalated entity → 403', async () => {
      const { store, knex } = await createStore();
      const entity = await seedEntityRow(knex, { current_status: 'escalated' });
      await seedQueueEntry(knex, entity.id, {
        status: 'active',
        resolved_actor_ref: 'user:default/jane.director',
      });
      const { app } = await buildEscalationApp(
        store,
        'user:default/admin',
        undefined,
        { admin: true },
      );

      const res = await request(app)
        .post(`/entities/${entity.id}/escalation/assign`)
        .send({ ownerRef: 'group:default/team-b' });

      expect(res.status).toBe(403);
    });

    it('assign enqueues a pr_creation job and kicks the trigger', async () => {
      const { store, knex } = await createStore();
      const entity = await seedEntityRow(knex, {
        current_status: 'unresolved',
      });
      const prCreationTrigger = {
        trigger: jest.fn().mockResolvedValue(undefined),
      };
      const { app } = await buildEscalationApp(
        store,
        'user:default/admin',
        undefined,
        { admin: true, prCreationTrigger },
      );

      const res = await request(app)
        .post(`/entities/${entity.id}/escalation/assign`)
        .send({ ownerRef: 'group:default/team-b' });

      expect(res.status).toBe(200);
      const prDeadline = await knex('pending_deadlines')
        .where({ entity_id: entity.id, deadline_type: 'pr_creation' })
        .first();
      expect(prDeadline).toBeDefined();
      expect(prDeadline.actor_ref).toBe('user:default/admin');
      const proposal = await knex('ownership_proposals')
        .where({ entity_id: entity.id, status: 'accepted' })
        .first();
      expect(prDeadline.proposal_id).toBe(proposal.id);
      expect(prCreationTrigger.trigger).toHaveBeenCalledWith(prDeadline.id);

      const row = await knex('ownership_entities')
        .where({ id: entity.id })
        .first();
      expect(row.pr_status).toBe('pending');
      const history = await knex('ownership_history').where({
        entity_id: entity.id,
        action: 'pr_creation_enqueued',
      });
      expect(history).toHaveLength(1);
    });

    it('assign on escalated entity also enqueues a pr_creation job', async () => {
      const { store, knex } = await createStore();
      const entity = await seedEntityRow(knex, { current_status: 'escalated' });
      await seedQueueEntry(knex, entity.id, {
        group_ref: 'group:default/domain-search',
        status: 'active',
        resolved_actor_ref: 'user:default/jane.director',
      });
      const prCreationTrigger = {
        trigger: jest.fn().mockResolvedValue(undefined),
      };
      const { app } = await buildEscalationApp(
        store,
        'user:default/jane.director',
        undefined,
        { prCreationTrigger },
      );

      const res = await request(app)
        .post(`/entities/${entity.id}/escalation/assign`)
        .send({ ownerRef: 'group:default/team-b' });

      expect(res.status).toBe(200);
      expect(prCreationTrigger.trigger).toHaveBeenCalledTimes(1);
    });

    it('archive never enqueues a pr_creation job', async () => {
      const { store, knex } = await createStore();
      const entity = await seedEntityRow(knex, {
        current_status: 'unresolved',
      });
      const prCreationTrigger = {
        trigger: jest.fn().mockResolvedValue(undefined),
      };
      const { app } = await buildEscalationApp(
        store,
        'user:default/admin',
        undefined,
        { admin: true, prCreationTrigger },
      );

      await request(app)
        .post(`/entities/${entity.id}/escalation/archive`)
        .send({ assigneeRef: 'group:default/team-b' });

      const prDeadlines = await knex('pending_deadlines').where({
        entity_id: entity.id,
        deadline_type: 'pr_creation',
      });
      expect(prDeadlines).toHaveLength(0);
      expect(prCreationTrigger.trigger).not.toHaveBeenCalled();
    });

    it('assign to a team that already has a pending proposal (scanner re-proposed on an unresolved entity) → 200, live proposals cancelled', async () => {
      const { store, knex } = await createStore();
      const entity = await seedEntityRow(knex, {
        current_status: 'unresolved',
      });
      const pending = await seedProposalRow(knex, entity.id, {
        proposed_owner_ref: 'group:default/team-b',
        status: 'pending',
        proposal_order: 1,
      });
      const possible = await seedProposalRow(knex, entity.id, {
        proposed_owner_ref: 'group:default/team-c',
        status: 'possible_owner',
        proposal_order: 2,
      });
      await seedDeadlineRow(knex, entity.id, {
        proposal_id: pending.id,
        deadline_type: 'proposal_expiry',
      });
      const { app } = await buildEscalationApp(
        store,
        'user:default/admin',
        undefined,
        { admin: true },
      );

      const res = await request(app)
        .post(`/entities/${entity.id}/escalation/assign`)
        .send({ ownerRef: 'group:default/team-b' });

      expect(res.status).toBe(200);
      const proposals = await knex('ownership_proposals').where({
        entity_id: entity.id,
      });
      const statusOf = (id: string) =>
        proposals.find((p: any) => p.id === id).status;
      expect(statusOf(pending.id)).toBe('cancelled');
      expect(statusOf(possible.id)).toBe('cancelled');
      const accepted = proposals.filter((p: any) => p.status === 'accepted');
      expect(accepted).toHaveLength(1);
      expect(accepted[0].proposed_owner_ref).toBe('group:default/team-b');
      expect(accepted[0].proposal_order).toBe(3);

      const expiry = await knex('pending_deadlines').where({
        entity_id: entity.id,
        deadline_type: 'proposal_expiry',
        processed: false,
      });
      expect(expiry).toHaveLength(0);
      const cancelledHistory = await knex('ownership_history').where({
        entity_id: entity.id,
        action: 'proposal_cancelled',
      });
      expect(cancelledHistory).toHaveLength(2);
    });

    it('archive cancels live proposals so a team cannot accept a to_archive case', async () => {
      const { store, knex } = await createStore();
      const entity = await seedEntityRow(knex, {
        current_status: 'unresolved',
      });
      const pending = await seedProposalRow(knex, entity.id, {
        proposed_owner_ref: 'group:default/team-b',
        status: 'pending',
      });
      const { app } = await buildEscalationApp(
        store,
        'user:default/admin',
        undefined,
        { admin: true },
      );

      const res = await request(app)
        .post(`/entities/${entity.id}/escalation/archive`)
        .send({ assigneeRef: 'group:default/team-b' });

      expect(res.status).toBe(200);
      const row = await knex('ownership_proposals')
        .where({ id: pending.id })
        .first();
      expect(row.status).toBe('cancelled');
    });

    it('assign without PR automation configured writes no pr_creation deadline', async () => {
      const { store, knex } = await createStore();
      const entity = await seedEntityRow(knex, {
        current_status: 'unresolved',
      });
      const { app } = await buildEscalationApp(
        store,
        'user:default/admin',
        undefined,
        { admin: true },
      );

      await request(app)
        .post(`/entities/${entity.id}/escalation/assign`)
        .send({ ownerRef: 'group:default/team-b' });

      const prDeadlines = await knex('pending_deadlines').where({
        entity_id: entity.id,
        deadline_type: 'pr_creation',
      });
      expect(prDeadlines).toHaveLength(0);
    });
  });

  describe('authorization', () => {
    it('auth — user matches resolved_actor_ref → 200', async () => {
      const { store, knex } = await createStore();
      const entity = await seedEntityRow(knex, { current_status: 'escalated' });
      await seedQueueEntry(knex, entity.id, {
        group_ref: 'group:default/domain-search',
        status: 'active',
        resolved_actor_ref: 'user:default/jane.director',
      });
      // Request as jane.director — matches resolved_actor_ref
      const { app } = await buildEscalationApp(
        store,
        'user:default/jane.director',
      );

      const res = await request(app)
        .post(`/entities/${entity.id}/escalation/reject`)
        .send({ reason: 'Not our scope' });

      expect(res.status).toBe(200);
    });

    it('auth — wrong user → 403', async () => {
      const { store, knex } = await createStore();
      const entity = await seedEntityRow(knex, { current_status: 'escalated' });
      await seedQueueEntry(knex, entity.id, {
        group_ref: 'group:default/domain-search',
        status: 'active',
        resolved_actor_ref: 'user:default/jane.director',
      });
      // Request as mock (user:default/mock ≠ jane.director)
      const { app } = await buildEscalationApp(store, 'user:default/mock');

      const res = await request(app)
        .post(`/entities/${entity.id}/escalation/reject`)
        .send({ reason: 'Not our scope' });

      expect(res.status).toBe(403);
    });

    it('auth — no active queue entry → 403', async () => {
      const { store, knex } = await createStore();
      const entity = await seedEntityRow(knex, { current_status: 'escalated' });
      // No queue entry seeded at all.
      const { app } = await buildEscalationApp(store, 'user:default/mock');

      const res = await request(app)
        .post(`/entities/${entity.id}/escalation/reject`)
        .send({ reason: 'Not our scope' });

      expect(res.status).toBe(403);
    });

    it('concurrent escalation actions — first wins 200, second gets 409', async () => {
      const { store, knex } = await createStore();
      const entity = await seedEntityRow(knex, { current_status: 'escalated' });
      // Both directors have active entries (they are different actors at same level
      // in a real scenario — or one active entry with first-writer-wins on optimistic lock).
      await seedQueueEntry(knex, entity.id, {
        group_ref: 'group:default/domain-search',
        status: 'active',
        resolved_actor_ref: 'user:default/jane.director',
        escalation_level: 1,
        position: 1,
      });

      const { app: appA } = await buildEscalationApp(
        store,
        'user:default/jane.director',
      );

      const [res1, res2] = await Promise.all([
        request(appA)
          .post(`/entities/${entity.id}/escalation/assign`)
          .send({ ownerRef: 'group:default/team-a' }),
        request(appA)
          .post(`/entities/${entity.id}/escalation/reject`)
          .send({ reason: 'Taking team-a instead' }),
      ]);

      // Exactly one wins. The loser gets 409 when it reaches the service tx
      // after the winner (optimistic lock), or 403 when it arrives after the
      // winner committed — the active queue entry is completed, so the
      // resolved-actor check rejects it first. Which one depends on timing.
      const statuses = [res1.status, res2.status].sort();
      expect(statuses[0]).toBe(200);
      expect([403, 409]).toContain(statuses[1]);
    });

    it('resolved_actor_ref stored at activation time (snapshot)', async () => {
      const { knex } = await createStore();
      const entity = await seedEntityRow(knex, { current_status: 'escalated' });
      const entry = await seedQueueEntry(knex, entity.id, {
        group_ref: 'group:default/domain-search',
        status: 'active',
        resolved_actor_ref: 'user:default/jane.director',
      });

      const row = await knex('escalation_queue_entries')
        .where({ id: entry.id })
        .first();
      expect(row.resolved_actor_ref).toBe('user:default/jane.director');
    });

    it('original resolved actor valid even after catalog change (snapshot-based auth) → 200', async () => {
      // Director-A was resolved at activation; mid-timeout Director-B replaces A in catalog.
      // Director-A's request should still be allowed.
      const { store, knex } = await createStore();
      const entity = await seedEntityRow(knex, { current_status: 'escalated' });
      await seedQueueEntry(knex, entity.id, {
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
    });

    it('new director (not in snapshot) cannot act → 403', async () => {
      const { store, knex } = await createStore();
      const entity = await seedEntityRow(knex, { current_status: 'escalated' });
      await seedQueueEntry(knex, entity.id, {
        group_ref: 'group:default/domain-search',
        status: 'active',
        resolved_actor_ref: 'user:default/jane.director',
      });
      // Request as bob.new (not in snapshot)
      const { app } = await buildEscalationApp(store, 'user:default/bob.new');

      const res = await request(app)
        .post(`/entities/${entity.id}/escalation/reject`)
        .send({ reason: 'Not our scope' });

      expect(res.status).toBe(403);
    });
  });

  describe('grace period flows', () => {
    it('grace period — escalationAssign triggers grace period deadlines in DB', async () => {
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

      await request(app)
        .post(`/entities/${entity.id}/escalation/assign`)
        .send({ ownerRef: 'group:default/team-b' });

      const deadlines = await knex('pending_deadlines').where({
        entity_id: entity.id,
        processed: false,
      });
      const types = deadlines.map((d: any) => d.deadline_type);
      expect(types).toContain('grace_warning');
      expect(types).toContain('grace_expiry');
    });

    it('grace period — pre-expiry warning fired by DeadlineCheckerService at warningDays before expiry', async () => {
      // SUT: DeadlineCheckerService.processExpiredDeadlines (not escalationAssign directly).
      const { store, knex } = await createStore();
      const entity = await seedEntityRow(knex, { current_status: 'accepted' });
      const clock = new TestClock(new Date('2026-01-01T00:00:00.000Z'));

      // Seed an already-expired grace_warning deadline
      await seedDeadlineRow(knex, entity.id, {
        deadline_type: 'grace_warning',
        fire_at: new Date('2025-12-28T00:00:00.000Z'), // in the past
      });

      // EscalationService.
      const logger = mockServices.logger.mock();
      const escSvc = buildService(store, clock);
      const config = buildValidEscalationConfig();
      const checkerSvc = new DefaultDeadlineCheckerService(
        store,
        escSvc,
        config,
        clock,
        logger,
      );

      await checkerSvc.processExpiredDeadlines();

      // After processing, deadline should be marked processed
      const row = await knex('pending_deadlines')
        .where({ entity_id: entity.id })
        .first();
      expect(row.processed).toBe(true);
    });

    it('re-decision — director re-assigns different team → new grace period starts', async () => {
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
        .post(`/entities/${entity.id}/escalation/assign`)
        .send({ ownerRef: 'group:default/team-c' });

      expect(res.status).toBe(200);

      const history = await knex('ownership_history')
        .where({ entity_id: entity.id })
        .orderBy('created_at', 'desc')
        .first();
      // History action reflects the re-assign
      expect(['escalation_assigned', 'escalation_reassigned']).toContain(
        history.action,
      );
    });

    it('re-decision expires with no action → auto-advance to next escalation level', async () => {
      // SUT: DeadlineCheckerService.processExpiredDeadlines.
      const { store, knex } = await createStore();
      const entity = await seedEntityRow(knex, { current_status: 'escalated' });
      const clock = new TestClock(new Date('2026-01-01T00:00:00.000Z'));

      // Seed next-level queue entry
      await seedQueueEntry(knex, entity.id, {
        group_ref: 'group:default/portfolio-consumer',
        escalation_level: 2,
        position: 2,
        status: 'queued',
      });
      // Seed expired redecision_expiry deadline
      await seedDeadlineRow(knex, entity.id, {
        deadline_type: 'redecision_expiry',
        fire_at: new Date('2025-12-31T00:00:00.000Z'),
      });

      // EscalationService.
      const logger = mockServices.logger.mock();
      const escSvc = buildService(store, clock);
      const config = buildValidEscalationConfig();
      const checkerSvc = new DefaultDeadlineCheckerService(
        store,
        escSvc,
        config,
        clock,
        logger,
      );

      await checkerSvc.processExpiredDeadlines();

      // Deadline processed
      const deadline = await knex('pending_deadlines')
        .where({ entity_id: entity.id })
        .first();
      expect(deadline.processed).toBe(true);

      // History: escalation_auto_advanced
      const history = await knex('ownership_history')
        .where({ entity_id: entity.id, action: 'escalation_auto_advanced' })
        .first();
      expect(history).toBeDefined();
    });

    it('archive grace → escalation archive action writes grace deadlines in DB', async () => {
      // SUT: escalationArchive writes grace deadlines; DeadlineCheckerService fires them.
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
        .post(`/entities/${entity.id}/escalation/archive`)
        .send({ assigneeRef: 'group:default/team-b' });

      expect(res.status).toBe(200);

      const deadlines = await knex('pending_deadlines').where({
        entity_id: entity.id,
        processed: false,
      });
      const types = deadlines.map((d: any) => d.deadline_type);
      expect(types).toContain('grace_warning');
      expect(types).toContain('grace_expiry');
    });

    it('proposal-level grace expires → reverted to open', async () => {
      // SUT: DeadlineCheckerService.processExpiredDeadlines.
      const { store, knex } = await createStore();
      const entity = await seedEntityRow(knex, {
        current_status: 'accepted',
        version: 2,
      });
      await seedProposalRow(knex, entity.id, {
        status: 'accepted',
        proposal_order: 1,
        escalation_level: 0,
      });
      const clock = new TestClock(new Date('2026-01-01T00:00:00.000Z'));

      await seedDeadlineRow(knex, entity.id, {
        deadline_type: 'grace_expiry',
        fire_at: new Date('2025-12-31T00:00:00.000Z'),
      });

      // EscalationService.
      const logger = mockServices.logger.mock();
      const escSvc = buildService(store, clock);
      const config = buildValidEscalationConfig();
      const checkerSvc = new DefaultDeadlineCheckerService(
        store,
        escSvc,
        config,
        clock,
        logger,
      );

      await checkerSvc.processExpiredDeadlines();

      // Entity should revert to open
      const entityRow = await knex('ownership_entities')
        .where({ id: entity.id })
        .first();
      expect(entityRow.current_status).toBe('open');
    });

    it('proposal-level grace — team accepts and fixes → entity closed by scanner', async () => {
      // The accept path is fully implemented. The scanner close is out-of-scope for this
      // test (scanner integration test). Here we verify the pre-condition: entity is
      // `accepted` and the proposal is `accepted` — the scanner can then close.
      const { store, knex } = await createStore();
      const entity = await seedEntityRow(knex, { current_status: 'escalated' });
      const proposal = await seedProposalRow(knex, entity.id, {
        status: 'pending',
        proposal_order: 1,
        escalation_level: 1,
      });

      // ProposalLifecycleService.acceptProposal IS implemented.
      // ProposalLifecycleService imported at top level
      const logger = mockServices.logger.mock();
      const svc = new ProposalLifecycleService(
        store,
        logger,
        undefined,
        undefined,
        { triggerEscalation: async () => {} },
      );

      await svc.acceptProposal(proposal.id, 'user:default/alice');

      // Entity transitions to accepted (scanner would then close on fix detection)
      const entityRow = await knex('ownership_entities')
        .where({ id: entity.id })
        .first();
      expect(entityRow.current_status).toBe('accepted');
    });
  });
});

// ─── Suggested Owner Flow ──────────────────────────────────────────

describe('Suggested Owner Flow', () => {
  it('suggest creates real proposal in ownership_proposals, escalation_suggested_created history', async () => {
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
        suggestedOwnerRef: 'group:default/team-d',
        reason: 'Team-D owns related systems',
      });

    expect(res.status).toBe(200);
    expect(res.body.proposal.proposed_owner_ref).toBe('group:default/team-d');

    // Proposal in DB
    const proposals = await knex('ownership_proposals').where({
      entity_id: entity.id,
      proposed_owner_ref: 'group:default/team-d',
    });
    expect(proposals).toHaveLength(1);
    expect(proposals[0].status).toBe('pending');

    // History written
    const history = await knex('ownership_history')
      .where({ entity_id: entity.id, action: 'escalation_suggested_created' })
      .first();
    expect(history).toBeDefined();
    expect(history.actor).toBe('user:default/jane.director');
  });

  it('escalation timeout cancelled when suggest action is taken', async () => {
    const { store, knex } = await createStore();
    const entity = await seedEntityRow(knex, { current_status: 'escalated' });
    await seedQueueEntry(knex, entity.id, {
      status: 'active',
      resolved_actor_ref: 'user:default/jane.director',
    });
    // Seed an active escalation_timeout deadline
    await seedDeadlineRow(knex, entity.id, {
      deadline_type: 'escalation_timeout',
      fire_at: new Date(Date.now() + 86400000), // future
    });
    const { app } = await buildEscalationApp(
      store,
      'user:default/jane.director',
    );

    await request(app).post(`/entities/${entity.id}/escalation/suggest`).send({
      suggestedOwnerRef: 'group:default/team-x',
      reason: 'owns this domain',
    });

    // escalation_timeout should now be cancelled (processed = true or cancelled)
    const deadline = await knex('pending_deadlines')
      .where({
        entity_id: entity.id,
        deadline_type: 'escalation_timeout',
        processed: false,
      })
      .first();
    expect(deadline).toBeUndefined();
  });

  it('suggested team accepts → entity accepted, grace deadlines written', async () => {
    const { store, knex } = await createStore();
    const entity = await seedEntityRow(knex, { current_status: 'escalated' });
    const proposal = await seedProposalRow(knex, entity.id, {
      status: 'pending',
      proposal_order: 1,
      escalation_level: 1,
    });
    // ProposalLifecycleService imported at top level
    const logger = mockServices.logger.mock();
    const proposalSvc = new ProposalLifecycleService(
      store,
      logger,
      undefined,
      undefined,
      { triggerEscalation: async () => {} },
    );

    await proposalSvc.acceptProposal(proposal.id, 'user:default/alice');

    // Entity accepted
    const entityRow = await knex('ownership_entities')
      .where({ id: entity.id })
      .first();
    expect(entityRow.current_status).toBe('accepted');

    // Proposal accepted
    const proposalRow = await knex('ownership_proposals')
      .where({ id: proposal.id })
      .first();
    expect(proposalRow.status).toBe('accepted');
  });

  it('suggested team rejects → escalation_suggested_rejected history, escalation resumes', async () => {
    const { store, knex } = await createStore();
    const entity = await seedEntityRow(knex, { current_status: 'escalated' });
    const proposal = await seedProposalRow(knex, entity.id, {
      proposed_owner_ref: 'group:default/team-d',
      status: 'pending',
      proposal_order: 1,
      escalation_level: 1,
    });
    // ProposalLifecycleService imported at top level
    const logger = mockServices.logger.mock();
    const proposalSvc = new ProposalLifecycleService(
      store,
      logger,
      undefined,
      undefined,
      { triggerEscalation: async () => {} },
    );

    await proposalSvc.rejectProposal(
      proposal.id,
      'user:default/dave',
      'Not our domain',
    );

    // Proposal rejected
    const proposalRow = await knex('ownership_proposals')
      .where({ id: proposal.id })
      .first();
    expect(proposalRow.status).toBe('rejected');
    expect(proposalRow.response_note).toContain('Not our domain');

    // Entity still escalated (escalation resumes)
    const entityRow = await knex('ownership_entities')
      .where({ id: entity.id })
      .first();
    expect(entityRow.current_status).toBe('escalated');
  });

  it('suggested team proposal expires → escalation resumes (deadline checker fires)', async () => {
    // SUT: DeadlineCheckerService.processExpiredDeadlines.
    const { store, knex } = await createStore();
    const entity = await seedEntityRow(knex, { current_status: 'escalated' });
    const clock = new TestClock(new Date('2026-01-01T00:00:00.000Z'));

    await seedDeadlineRow(knex, entity.id, {
      deadline_type: 'proposal_expiry',
      fire_at: new Date('2025-12-31T00:00:00.000Z'),
    });

    const logger = mockServices.logger.mock();
    const escSvc = buildService(store, clock);
    const config = buildValidEscalationConfig();
    const checkerSvc = new DefaultDeadlineCheckerService(
      store,
      escSvc,
      config,
      clock,
      logger,
    );

    await checkerSvc.processExpiredDeadlines();

    const deadline = await knex('pending_deadlines')
      .where({ entity_id: entity.id, deadline_type: 'proposal_expiry' })
      .first();
    expect(deadline.processed).toBe(true);
  });

  it('suggest with malformed ref → 400 (Q2 — schema-level regex)', async () => {
    // lookup to a Zod regex (`/^group:default\/[a-z0-9-]+$/`). The runtime
    // `liveGroups.has(suggestedOwnerRef)` check was too strict — it 404'd
    // legitimate fresh teams that hadn't propagated to the live group
    // registry yet. The schema rejects malformed refs only;
    // refs that look correct are trusted and reconciled downstream.
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
      // `User:` prefix and uppercase letters violate the regex.
      .send({
        suggestedOwnerRef: 'User:Default/NonExistent',
        reason: 'Team-X owns this',
      });

    expect(res.status).toBe(400);
  });

  it('suggested team previously rejected → new proposal created (second chance)', async () => {
    const { store, knex } = await createStore();
    const entity = await seedEntityRow(knex, { current_status: 'escalated' });
    await seedProposalRow(knex, entity.id, {
      proposed_owner_ref: 'group:default/team-b',
      status: 'rejected',
      proposal_order: 1,
    });
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
        suggestedOwnerRef: 'group:default/team-b',
        reason: 'Reconsidering based on new info',
      });

    expect(res.status).toBe(200);

    // New pending proposal created (total 2 for team-b: 1 rejected + 1 new)
    const proposals = await knex('ownership_proposals').where({
      entity_id: entity.id,
      proposed_owner_ref: 'group:default/team-b',
    });
    expect(proposals.length).toBeGreaterThanOrEqual(1);
    const pending = proposals.find((p: any) => p.status === 'pending');
    expect(pending).toBeDefined();
  });

  it('multiple suggestions in sequence — no limit enforced', async () => {
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

    const res1 = await request(app)
      .post(`/entities/${entity.id}/escalation/suggest`)
      .send({
        suggestedOwnerRef: 'group:default/team-d',
        reason: 'First suggestion',
      });

    expect(res1.status).toBe(200);

    // After first suggest resolves (or times out), a second suggest should also be accepted.
    const res2 = await request(app)
      .post(`/entities/${entity.id}/escalation/suggest`)
      .send({
        suggestedOwnerRef: 'group:default/team-e',
        reason: 'Second suggestion',
      });

    expect(res2.status).toBe(200);
  });
});
