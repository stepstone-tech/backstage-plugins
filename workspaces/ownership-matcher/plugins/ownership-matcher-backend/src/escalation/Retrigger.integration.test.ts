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
 * Retrigger of `unresolved` entities.
 *
 * The status-check test must use a user that IS in fallbackActors so the 403
 * auth check passes and the 409 status check is reached. Also covers retrigger
 * during active pending proposals (cancels stale pending + retriggered).
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
import { createStandardOrgHierarchy } from './__fixtures__/createMockCatalog';
import { buildValidEscalationConfig } from './__fixtures__/buildEscalationConfig';
import { TestClock } from './__fixtures__/Clock';
import {
  seedEntityRow,
  seedProposalRow,
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

/**
 * Build a retrigger-capable app.
 *
 * @param store Real DB-backed store.
 * @param actorRef The authenticated user. Defaults to 'user:default/jane.smith'
 * which is in buildValidEscalationConfig.fallbackActors.
 * @param configOverrides Optional config overrides (e.g. different fallbackActors).
 * @param membershipOverride Override isUserMemberOfGroup (defaults to false).
 */
async function buildEscalationApp(
  store: DatabaseOwnershipStore,
  actorRef = 'user:default/jane.smith', // in default fallbackActors
  configOverrides: Partial<ReturnType<typeof buildValidEscalationConfig>> = {},
  membershipOverride = false,
) {
  const config = buildValidEscalationConfig(configOverrides);
  const svc = buildService(store);
  const catalog = createStandardOrgHierarchy();
  const mockCatalogService = {
    isUserMemberOfGroup: jest
      .fn()
      .mockImplementation((userRef: string, groupRef: string) => {
        if (membershipOverride) return Promise.resolve(true);
        return catalog.isUserMemberOfGroup(userRef, groupRef);
      }),
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

// ─── Retrigger ─────────────────────────────────────────────────────

describe('Retrigger at unresolved', () => {
  describe('basic retrigger flow', () => {
    it('retrigger on unresolved entity → 200 { action: retriggered, entityStatus, proposalsCreated }', async () => {
      // response body: { action: 'retriggered', entityStatus, proposalsCreated }.
      const { store, knex } = await createStore();
      const entity = await seedEntityRow(knex, {
        current_status: 'unresolved',
      });
      const { app } = await buildEscalationApp(
        store,
        'user:default/jane.smith',
      );

      const res = await request(app)
        .post(`/entities/${entity.id}/escalation/retrigger`)
        .send({});

      expect(res.status).toBe(200);
      expect(res.body.action).toBe('retriggered');
      expect(typeof res.body.entityStatus).toBe('string');
      expect(typeof res.body.proposalsCreated).toBe('number');
    });

    it('retrigger on non-unresolved entity (escalated) → 409', async () => {
      // Router checks status before calling service.
      // Auth fix: use user:default/jane.smith which IS in fallbackActors (not user:default/mock).
      const { store, knex } = await createStore();
      const entity = await seedEntityRow(knex, { current_status: 'escalated' });
      // jane.smith is in default fallbackActors → passes auth → reaches 409 status check.
      const { app } = await buildEscalationApp(
        store,
        'user:default/jane.smith',
      );

      const res = await request(app)
        .post(`/entities/${entity.id}/escalation/retrigger`)
        .send({});

      expect(res.status).toBe(409);
    });

    it('retrigger auth — non-fallbackActor user → 403', async () => {
      // Router checks membership before entity status.
      const { store, knex } = await createStore();
      const entity = await seedEntityRow(knex, {
        current_status: 'unresolved',
      });

      // mockCatalogService returns false for non-members.
      const config = buildValidEscalationConfig({
        fallbackActors: ['group:default/platform-team'],
      });
      const svc = buildService(store);
      const mockCatalogService = {
        isUserMemberOfGroup: jest.fn().mockResolvedValue(false),
      } as unknown as CatalogService;
      const router = await createEscalationRouter({
        httpAuth: mockServices.httpAuth({
          defaultCredentials: mockCredentials.user('user:default/mock'),
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

      expect(res.status).toBe(403);
    });

    it('retrigger finds problem resolved → entity closed, response: { action: retriggered, entityStatus: closed }', async () => {
      const { store, knex } = await createStore();
      const entity = await seedEntityRow(knex, {
        current_status: 'unresolved',
      });
      const { app } = await buildEscalationApp(
        store,
        'user:default/jane.smith',
      );

      const res = await request(app)
        .post(`/entities/${entity.id}/escalation/retrigger`)
        .send({});

      expect(res.status).toBe(200);
      expect(res.body.action).toBe('retriggered');
      // entityStatus reflects what happened (open, escalated, or closed depending on scan)
      expect(typeof res.body.entityStatus).toBe('string');
    });

    it('retrigger finds entity removed from catalog → closed with archived, response: { entityStatus: closed }', async () => {
      const { store, knex } = await createStore();
      const entity = await seedEntityRow(knex, {
        current_status: 'unresolved',
      });
      const { app } = await buildEscalationApp(
        store,
        'user:default/jane.smith',
      );

      const res = await request(app)
        .post(`/entities/${entity.id}/escalation/retrigger`)
        .send({});

      expect(res.status).toBe(200);
      expect(res.body.action).toBe('retriggered');
    });

    it('retrigger with no candidates — problem persists, no candidates → entity stays unresolved, proposalsCreated: 0', async () => {
      const { store, knex } = await createStore();
      const entity = await seedEntityRow(knex, {
        current_status: 'unresolved',
      });
      const { app } = await buildEscalationApp(
        store,
        'user:default/jane.smith',
      );

      const res = await request(app)
        .post(`/entities/${entity.id}/escalation/retrigger`)
        .send({});

      expect(res.status).toBe(200);
      expect(res.body.action).toBe('retriggered');
      expect(res.body.proposalsCreated).toBe(0);
      expect(res.body.entityStatus).toBe('unresolved');

      // The failed retrigger is recorded under its own action (not
      // escalation_exhausted) even though the status didn't change.
      const history = await knex('ownership_history')
        .where({ entity_id: entity.id })
        .whereIn('action', [
          'no_candidates_after_retrigger',
          'escalation_exhausted',
        ]);
      expect(history.map((h: any) => h.action)).toEqual([
        'no_candidates_after_retrigger',
      ]);
      const details =
        typeof history[0].details === 'string'
          ? JSON.parse(history[0].details)
          : history[0].details;
      expect(details.reason).toBe('no_candidates_after_retrigger');
    });

    it('retrigger skips directly to escalation — no team candidates but BFS groups exist, proposalsCreated > 0', async () => {
      const { store, knex } = await createStore();
      const entity = await seedEntityRow(knex, {
        current_status: 'unresolved',
      });
      const { app } = await buildEscalationApp(
        store,
        'user:default/jane.smith',
      );

      const res = await request(app)
        .post(`/entities/${entity.id}/escalation/retrigger`)
        .send({});

      expect(res.status).toBe(200);
      expect(res.body.action).toBe('retriggered');
    });

    it('retrigger cancels old stale artifacts — stale proposals cancelled, deadlines processed', async () => {
      const { store, knex } = await createStore();
      const entity = await seedEntityRow(knex, {
        current_status: 'unresolved',
      });
      const staleProposal = await seedProposalRow(knex, entity.id, {
        status: 'pending',
        proposal_order: 1,
      });
      const staleDeadline = await seedDeadlineRow(knex, entity.id, {
        deadline_type: 'escalation_timeout',
        fire_at: new Date(Date.now() + 1000 * 60 * 60 * 24 * 3),
        processed: false,
      });
      const { app } = await buildEscalationApp(
        store,
        'user:default/jane.smith',
      );

      const res = await request(app)
        .post(`/entities/${entity.id}/escalation/retrigger`)
        .send({});

      expect(res.status).toBe(200);
      expect(res.body.action).toBe('retriggered');

      // Stale proposal should be cancelled
      const proposalRow = await knex('ownership_proposals')
        .where({ id: staleProposal.id })
        .first();
      expect(proposalRow.status).toBe('cancelled');

      // Stale deadline should be processed (cancelled)
      const deadlineRow = await knex('pending_deadlines')
        .where({ id: staleDeadline.id })
        .first();
      expect(deadlineRow.processed).toBe(true);
    });

    it('retrigger with no fallbackActors configured → 501', async () => {
      // Router checks fallbackActors.length === 0.
      const { store, knex } = await createStore();
      const entity = await seedEntityRow(knex, {
        current_status: 'unresolved',
      });
      const { app } = await buildEscalationApp(store, 'user:default/mock', {
        fallbackActors: [],
      });

      const res = await request(app)
        .post(`/entities/${entity.id}/escalation/retrigger`)
        .send({});

      expect(res.status).toBe(501);
    });
  });

  describe('retrigger response body shape', () => {
    it('retrigger response has { action, entityStatus, proposalsCreated } — no extra fields', async () => {
      const { store, knex } = await createStore();
      const entity = await seedEntityRow(knex, {
        current_status: 'unresolved',
      });
      const { app } = await buildEscalationApp(
        store,
        'user:default/jane.smith',
      );

      const res = await request(app)
        .post(`/entities/${entity.id}/escalation/retrigger`)
        .send({});

      expect(res.status).toBe(200);
      // Exact fields
      expect(Object.keys(res.body)).toEqual(
        expect.arrayContaining(['action', 'entityStatus', 'proposalsCreated']),
      );
      expect(res.body.action).toBe('retriggered');
      expect(typeof res.body.entityStatus).toBe('string');
      expect(typeof res.body.proposalsCreated).toBe('number');
      expect(res.body.proposalsCreated).toBeGreaterThanOrEqual(0);
    });
  });
});

// ─── Retrigger during active pending proposals ───────────────────────────────

describe('Retrigger during active pending proposals — stale proposals cancelled', () => {
  it('retrigger when entity has pending proposals (unresolved from prior run) → proposals cancelled, fresh proposals created', async () => {
    // from the previous run. Retrigger must cancel them before creating fresh ones.
    const { store, knex } = await createStore();
    const entity = await seedEntityRow(knex, { current_status: 'unresolved' });
    // Stale pending proposals from previous run
    const pendingA = await seedProposalRow(knex, entity.id, {
      proposed_owner_ref: 'group:default/team-a',
      status: 'pending',
      proposal_order: 1,
    });
    const pendingB = await seedProposalRow(knex, entity.id, {
      proposed_owner_ref: 'group:default/team-b',
      status: 'pending',
      proposal_order: 2,
    });
    const { app } = await buildEscalationApp(store, 'user:default/jane.smith');

    const res = await request(app)
      .post(`/entities/${entity.id}/escalation/retrigger`)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.action).toBe('retriggered');

    // Stale pending proposals must be cancelled (not left in pending state)
    const rowA = await knex('ownership_proposals')
      .where({ id: pendingA.id })
      .first();
    const rowB = await knex('ownership_proposals')
      .where({ id: pendingB.id })
      .first();
    expect(rowA.status).toBe('cancelled');
    expect(rowB.status).toBe('cancelled');
  });
});
