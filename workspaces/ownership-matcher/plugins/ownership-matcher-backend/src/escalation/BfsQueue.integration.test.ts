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
 * Escalation level resolution (domain-first BFS) and multi-path escalation.
 *
 * The multi-domain team test is skipped because MockCatalog only supports a
 * single parentRef per group; createMockCatalog needs multi-parent support
 * before it can be enabled.
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

// ─── Escalation Level Resolution — Domain-First, BFS ────────────────

describe('Escalation Level Resolution — Domain-First BFS', () => {
  it('single-domain — builds queue with one domain entry for domain-search', async () => {
    const { store, knex } = await createStore();
    const entity = await seedEntityRow(knex, { current_status: 'escalated' });
    await seedProposalRow(knex, entity.id, {
      proposed_owner_ref: 'group:default/team-a',
      status: 'rejected',
      proposal_order: 1,
    });
    const svc = buildService(store);

    await svc.buildBfsQueue(entity.id, new Set());

    const entries = await knex('escalation_queue_entries').where({
      entity_id: entity.id,
    });
    // At minimum one domain-level entry
    expect(entries.length).toBeGreaterThanOrEqual(1);
    const domainEntry = entries.find(
      (e: any) => e.group_ref === 'group:default/domain-search',
    );
    expect(domainEntry).toBeDefined();
    expect(domainEntry.escalation_level).toBe(1);
  });

  it('multi-domain BFS ordered by proposal score — domain-A (0.8) before domain-B (0.5)', async () => {
    const { store, knex } = await createStore();
    const entity = await seedEntityRow(knex, { current_status: 'escalated' });
    // team-a under domain-search (score 0.8), team-c under domain-payments (score 0.5)
    await seedProposalRow(knex, entity.id, {
      proposed_owner_ref: 'group:default/team-a',
      status: 'rejected',
      proposal_order: 1,
      confidence_score: 0.8,
    });
    await seedProposalRow(knex, entity.id, {
      proposed_owner_ref: 'group:default/team-c',
      status: 'rejected',
      proposal_order: 2,
      confidence_score: 0.5,
    });
    const svc = buildService(store);

    await svc.buildBfsQueue(entity.id, new Set());

    const entries = await knex('escalation_queue_entries')
      .where({ entity_id: entity.id, escalation_level: 1 })
      .orderBy('position');
    // domain-search entry should come before domain-payments
    const searchPos = entries.find(
      (e: any) => e.group_ref === 'group:default/domain-search',
    )?.position;
    const paymentsPos = entries.find(
      (e: any) => e.group_ref === 'group:default/domain-payments',
    )?.position;
    expect(searchPos).toBeDefined();
    expect(paymentsPos).toBeDefined();
    expect(searchPos).toBeLessThan(paymentsPos);
  });

  it('all domain actors exhausted → portfolio VP notified (activateNextEntry advances)', async () => {
    const { store, knex } = await createStore();
    const entity = await seedEntityRow(knex, { current_status: 'escalated' });
    await seedProposalRow(knex, entity.id, {
      proposed_owner_ref: 'group:default/team-a',
      status: 'rejected',
      proposal_order: 1,
    });
    // All domain entries completed; portfolio entry queued
    await seedQueueEntry(knex, entity.id, {
      group_ref: 'group:default/domain-search',
      escalation_level: 1,
      position: 1,
      status: 'completed',
      resolved_actor_ref: 'user:default/jane.director',
    });
    await seedQueueEntry(knex, entity.id, {
      group_ref: 'group:default/portfolio-consumer',
      escalation_level: 2,
      position: 10,
      status: 'queued',
    });
    const svc = buildService(store);

    await svc.activateNextEntry(entity.id);

    // Portfolio entry should become active
    const portfolioEntry = await knex('escalation_queue_entries')
      .where({
        entity_id: entity.id,
        group_ref: 'group:default/portfolio-consumer',
      })
      .first();
    expect(portfolioEntry.status).toBe('active');
    expect(portfolioEntry.resolved_actor_ref).toBeDefined();
  });

  it('domain deduplication — two teams under same domain → director appears once in queue', async () => {
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

    // domain-search must appear exactly once
    const domainEntries = await knex('escalation_queue_entries').where({
      entity_id: entity.id,
      group_ref: 'group:default/domain-search',
    });
    expect(domainEntries).toHaveLength(1);
  });

  it('portfolio deduplication — two domains under same portfolio → VP appears once', async () => {
    // vp.consumer appears once.
    const { store, knex } = await createStore();
    const entity = await seedEntityRow(knex, { current_status: 'escalated' });
    await seedProposalRow(knex, entity.id, {
      proposed_owner_ref: 'group:default/team-a',
      status: 'rejected',
      proposal_order: 1,
    });
    await seedProposalRow(knex, entity.id, {
      proposed_owner_ref: 'group:default/team-c',
      status: 'rejected',
      proposal_order: 2,
    });
    const svc = buildService(store);

    await svc.buildBfsQueue(entity.id, new Set());

    // portfolio-consumer must appear exactly once
    const portfolioEntries = await knex('escalation_queue_entries').where({
      entity_id: entity.id,
      group_ref: 'group:default/portfolio-consumer',
    });
    expect(portfolioEntries).toHaveLength(1);
  });

  it('portfolio BFS ordered by score — higher-score portfolio VP first', async () => {
    const catalog = createStandardOrgHierarchy();
    catalog.addGroup('group:default/portfolio-data', {
      kind: 'Group',
      specType: 'portfolio',
    });
    catalog.addGroup('group:default/domain-data', {
      kind: 'Group',
      specType: 'domain',
      parentRef: 'group:default/portfolio-data',
    });
    catalog.addGroup('group:default/team-data', {
      kind: 'Group',
      specType: 'team',
      parentRef: 'group:default/domain-data',
    });
    catalog.addUser(
      'user:default/data.director',
      'Engineering Director, Data',
      'group:default/domain-data',
    );
    catalog.addUser(
      'user:default/vp.data',
      'Vice President, Technology',
      'group:default/portfolio-data',
    );

    const { store, knex } = await createStore();
    const entity = await seedEntityRow(knex, { current_status: 'escalated' });
    // team-a score 0.9 (under portfolio-consumer), team-data score 0.6 (under portfolio-data)
    await seedProposalRow(knex, entity.id, {
      proposed_owner_ref: 'group:default/team-a',
      status: 'rejected',
      proposal_order: 1,
      confidence_score: 0.9,
    });
    await seedProposalRow(knex, entity.id, {
      proposed_owner_ref: 'group:default/team-data',
      status: 'rejected',
      proposal_order: 2,
      confidence_score: 0.6,
    });
    const svc = buildService(store, catalog);

    await svc.buildBfsQueue(entity.id, new Set());

    const portfolioEntries = await knex('escalation_queue_entries')
      .where({ entity_id: entity.id, escalation_level: 2 })
      .orderBy('position');
    // portfolio-consumer (higher score) should appear before portfolio-data
    const consumerPos = portfolioEntries.find(
      (e: any) => e.group_ref === 'group:default/portfolio-consumer',
    )?.position;
    const dataPos = portfolioEntries.find(
      (e: any) => e.group_ref === 'group:default/portfolio-data',
    )?.position;
    expect(consumerPos).toBeDefined();
    expect(dataPos).toBeDefined();
    expect(consumerPos).toBeLessThan(dataPos);
  });

  it.skip('multi-domain team — team childOf two domains causes both directors in BFS queue [SKIPPED: MockCatalog does not support multi-parent]', async () => {
    // Blocked: createMockCatalog enforces single parentRef per group.
  });

  it('team with no parent domain — level skipped for that path, other paths continue', async () => {
    const catalog = createStandardOrgHierarchy();
    catalog.addGroup('group:default/team-orphan', {
      kind: 'Group',
      specType: 'team',
      // No parentRef → no domain
    });
    const { store, knex } = await createStore();
    const entity = await seedEntityRow(knex, { current_status: 'escalated' });
    await seedProposalRow(knex, entity.id, {
      proposed_owner_ref: 'group:default/team-orphan',
      status: 'rejected',
      proposal_order: 1,
    });
    await seedProposalRow(knex, entity.id, {
      proposed_owner_ref: 'group:default/team-a',
      status: 'rejected',
      proposal_order: 2,
    });
    const svc = buildService(store, catalog);

    await svc.buildBfsQueue(entity.id, new Set());

    // team-a's domain (domain-search) should still be in the queue
    const domainSearchEntry = await knex('escalation_queue_entries')
      .where({ entity_id: entity.id, group_ref: 'group:default/domain-search' })
      .first();
    expect(domainSearchEntry).toBeDefined();
  });

  it('domain with no portfolio parent — path ends for that domain, others with portfolio continue', async () => {
    const catalog = createStandardOrgHierarchy();
    catalog.addGroup('group:default/domain-orphan', {
      kind: 'Group',
      specType: 'domain',
      // No parentRef → no portfolio
    });
    catalog.addGroup('group:default/team-e', {
      kind: 'Group',
      specType: 'team',
      parentRef: 'group:default/domain-orphan',
    });
    catalog.addUser(
      'user:default/orphan.director',
      'Engineering Director, Orphan',
      'group:default/domain-orphan',
    );
    const { store, knex } = await createStore();
    const entity = await seedEntityRow(knex, { current_status: 'escalated' });
    await seedProposalRow(knex, entity.id, {
      proposed_owner_ref: 'group:default/team-e',
      status: 'rejected',
      proposal_order: 1,
    });
    await seedProposalRow(knex, entity.id, {
      proposed_owner_ref: 'group:default/team-a',
      status: 'rejected',
      proposal_order: 2,
    });
    const svc = buildService(store, catalog);

    await svc.buildBfsQueue(entity.id, new Set());

    // domain-orphan (no portfolio parent) AND domain-search (has portfolio) both in queue at level 1
    const domainOrphanEntry = await knex('escalation_queue_entries')
      .where({ entity_id: entity.id, group_ref: 'group:default/domain-orphan' })
      .first();
    const domainSearchEntry = await knex('escalation_queue_entries')
      .where({ entity_id: entity.id, group_ref: 'group:default/domain-search' })
      .first();
    expect(domainOrphanEntry).toBeDefined();
    expect(domainSearchEntry).toBeDefined();
  });
});

// ─── BFS Multi-Path Escalation ────────────────────────────────────

describe('BFS Multi-Path Escalation', () => {
  it('3 domains BFS ordered by score — director-A (0.9) first, B (0.6), C (0.3)', async () => {
    const catalog = createStandardOrgHierarchy();
    catalog.addGroup('group:default/domain-c', {
      kind: 'Group',
      specType: 'domain',
      parentRef: 'group:default/portfolio-consumer',
    });
    catalog.addGroup('group:default/team-c2', {
      kind: 'Group',
      specType: 'team',
      parentRef: 'group:default/domain-c',
    });
    catalog.addUser(
      'user:default/c.director',
      'Engineering Director, C',
      'group:default/domain-c',
    );

    const { store, knex } = await createStore();
    const entity = await seedEntityRow(knex, { current_status: 'escalated' });
    await seedProposalRow(knex, entity.id, {
      proposed_owner_ref: 'group:default/team-a',
      status: 'rejected',
      proposal_order: 1,
      confidence_score: 0.9,
    });
    await seedProposalRow(knex, entity.id, {
      proposed_owner_ref: 'group:default/team-c',
      status: 'rejected',
      proposal_order: 2,
      confidence_score: 0.6,
    });
    await seedProposalRow(knex, entity.id, {
      proposed_owner_ref: 'group:default/team-c2',
      status: 'rejected',
      proposal_order: 3,
      confidence_score: 0.3,
    });
    const svc = buildService(store, catalog);

    await svc.buildBfsQueue(entity.id, new Set());

    const entries = await knex('escalation_queue_entries')
      .where({ entity_id: entity.id, escalation_level: 1 })
      .orderBy('position');
    // domain-search (0.9) < domain-payments (0.6) < domain-c (0.3)
    const searchPos = entries.find(
      (e: any) => e.group_ref === 'group:default/domain-search',
    )?.position;
    const paymentsPos = entries.find(
      (e: any) => e.group_ref === 'group:default/domain-payments',
    )?.position;
    const cPos = entries.find(
      (e: any) => e.group_ref === 'group:default/domain-c',
    )?.position;
    expect(searchPos).toBeLessThan(paymentsPos);
    expect(paymentsPos).toBeLessThan(cPos);
  });

  it('domain rejection → next domain notified, NOT portfolio VP', async () => {
    const { store, knex } = await createStore();
    const entity = await seedEntityRow(knex, { current_status: 'escalated' });
    await seedQueueEntry(knex, entity.id, {
      group_ref: 'group:default/domain-search',
      escalation_level: 1,
      position: 1,
      status: 'active',
      resolved_actor_ref: 'user:default/jane.director',
    });
    await seedQueueEntry(knex, entity.id, {
      group_ref: 'group:default/domain-payments',
      escalation_level: 1,
      position: 2,
      status: 'queued',
    });
    await seedQueueEntry(knex, entity.id, {
      group_ref: 'group:default/portfolio-consumer',
      escalation_level: 2,
      position: 10,
      status: 'queued',
    });
    const { app } = await buildEscalationApp(
      store,
      'user:default/jane.director',
    );

    await request(app)
      .post(`/entities/${entity.id}/escalation/reject`)
      .send({ reason: 'Not our scope' });

    // domain-payments should now be active, not portfolio
    const paymentsEntry = await knex('escalation_queue_entries')
      .where({
        entity_id: entity.id,
        group_ref: 'group:default/domain-payments',
      })
      .first();
    expect(paymentsEntry.status).toBe('active');
    // portfolio should remain queued
    const portfolioEntry = await knex('escalation_queue_entries')
      .where({
        entity_id: entity.id,
        group_ref: 'group:default/portfolio-consumer',
      })
      .first();
    expect(portfolioEntry.status).toBe('queued');
  });

  it('all 3 domain directors exhausted → portfolio VP notified', async () => {
    const { store, knex } = await createStore();
    const entity = await seedEntityRow(knex, { current_status: 'escalated' });
    // All domain entries completed
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
      status: 'completed',
      resolved_actor_ref: 'user:default/bob.director',
    });
    await seedQueueEntry(knex, entity.id, {
      group_ref: 'group:default/portfolio-consumer',
      escalation_level: 2,
      position: 10,
      status: 'queued',
    });
    const svc = buildService(store);

    await svc.activateNextEntry(entity.id);

    const portfolioEntry = await knex('escalation_queue_entries')
      .where({
        entity_id: entity.id,
        group_ref: 'group:default/portfolio-consumer',
      })
      .first();
    expect(portfolioEntry.status).toBe('active');
    expect(portfolioEntry.resolved_actor_ref).toBeDefined();
  });

  it('portfolio deduplication — domain-A and domain-B both under portfolio-consumer → VP appears once', async () => {
    const { store, knex } = await createStore();
    const entity = await seedEntityRow(knex, { current_status: 'escalated' });
    await seedProposalRow(knex, entity.id, {
      proposed_owner_ref: 'group:default/team-a',
      status: 'rejected',
      proposal_order: 1,
      confidence_score: 0.9,
    });
    await seedProposalRow(knex, entity.id, {
      proposed_owner_ref: 'group:default/team-c',
      status: 'rejected',
      proposal_order: 2,
      confidence_score: 0.8,
    });
    const svc = buildService(store);

    await svc.buildBfsQueue(entity.id, new Set());

    const portfolioEntries = await knex('escalation_queue_entries').where({
      entity_id: entity.id,
      group_ref: 'group:default/portfolio-consumer',
    });
    expect(portfolioEntries).toHaveLength(1);
  });

  it('deduplication keeps highest score — domain-A (0.9) and domain-B (0.3) same portfolio: consumer VP first', async () => {
    // contributing domain score is kept.
    const catalog = createStandardOrgHierarchy();
    catalog.addGroup('group:default/portfolio-secondary', {
      kind: 'Group',
      specType: 'portfolio',
    });
    catalog.addGroup('group:default/domain-secondary', {
      kind: 'Group',
      specType: 'domain',
      parentRef: 'group:default/portfolio-secondary',
    });
    catalog.addGroup('group:default/team-d', {
      kind: 'Group',
      specType: 'team',
      parentRef: 'group:default/domain-secondary',
    });
    catalog.addUser(
      'user:default/secondary.vp',
      'Vice President, Technology',
      'group:default/portfolio-secondary',
    );

    const { store, knex } = await createStore();
    const entity = await seedEntityRow(knex, { current_status: 'escalated' });
    // domain-search (consumer) gets score 0.9; domain-secondary gets 0.3
    await seedProposalRow(knex, entity.id, {
      proposed_owner_ref: 'group:default/team-a',
      status: 'rejected',
      proposal_order: 1,
      confidence_score: 0.9,
    });
    await seedProposalRow(knex, entity.id, {
      proposed_owner_ref: 'group:default/team-d',
      status: 'rejected',
      proposal_order: 2,
      confidence_score: 0.3,
    });
    const svc = buildService(store, catalog);

    await svc.buildBfsQueue(entity.id, new Set());

    const portfolioEntries = await knex('escalation_queue_entries')
      .where({ entity_id: entity.id, escalation_level: 2 })
      .orderBy('position');
    // portfolio-consumer (score 0.9) before portfolio-secondary (score 0.3)
    const consumerPos = portfolioEntries.find(
      (e: any) => e.group_ref === 'group:default/portfolio-consumer',
    )?.position;
    const secondaryPos = portfolioEntries.find(
      (e: any) => e.group_ref === 'group:default/portfolio-secondary',
    )?.position;
    expect(consumerPos).toBeDefined();
    expect(secondaryPos).toBeDefined();
    expect(consumerPos).toBeLessThan(secondaryPos);
  });

  it('single-domain linear escalation — director → VP → unresolved', async () => {
    const { store, knex } = await createStore();
    const entity = await seedEntityRow(knex, { current_status: 'escalated' });
    await seedProposalRow(knex, entity.id, {
      proposed_owner_ref: 'group:default/team-a',
      status: 'rejected',
      proposal_order: 1,
    });
    const svc = buildService(store);

    await svc.buildBfsQueue(entity.id, new Set());

    // Both domain and portfolio entries should be in the queue
    const entries = await knex('escalation_queue_entries').where({
      entity_id: entity.id,
    });
    const domainEntry = entries.find((e: any) => e.escalation_level === 1);
    const portfolioEntry = entries.find((e: any) => e.escalation_level === 2);
    expect(domainEntry).toBeDefined();
    expect(portfolioEntry).toBeDefined();
  });

  it('mixed — domain-orphan has no portfolio parent, other paths continue to portfolio', async () => {
    const catalog = createStandardOrgHierarchy();
    catalog.addGroup('group:default/domain-orphan2', {
      kind: 'Group',
      specType: 'domain',
      // No parentRef
    });
    catalog.addGroup('group:default/team-f', {
      kind: 'Group',
      specType: 'team',
      parentRef: 'group:default/domain-orphan2',
    });
    catalog.addUser(
      'user:default/orphan2.director',
      'Engineering Director, Orphan2',
      'group:default/domain-orphan2',
    );

    const { store, knex } = await createStore();
    const entity = await seedEntityRow(knex, { current_status: 'escalated' });
    await seedProposalRow(knex, entity.id, {
      proposed_owner_ref: 'group:default/team-a',
      status: 'rejected',
      proposal_order: 1,
    });
    await seedProposalRow(knex, entity.id, {
      proposed_owner_ref: 'group:default/team-f',
      status: 'rejected',
      proposal_order: 2,
    });
    const svc = buildService(store, catalog);

    await svc.buildBfsQueue(entity.id, new Set());

    // domain-search (has portfolio parent) should have portfolio-consumer entry in queue
    const portfolioEntry = await knex('escalation_queue_entries')
      .where({
        entity_id: entity.id,
        group_ref: 'group:default/portfolio-consumer',
      })
      .first();
    expect(portfolioEntry).toBeDefined();
  });
});

async function buildEscalationApp(
  store: DatabaseOwnershipStore,
  actorRef = 'user:default/mock',
) {
  const config = buildValidEscalationConfig();
  const catalog = createStandardOrgHierarchy();
  const clock = new TestClock();
  const logger = mockServices.logger.mock();
  const mockScanner = { runScan: jest.fn(), scanEntity: jest.fn() } as any;
  const mockProposalGen = {
    generateProposalsForEntity: jest.fn().mockResolvedValue(0),
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
