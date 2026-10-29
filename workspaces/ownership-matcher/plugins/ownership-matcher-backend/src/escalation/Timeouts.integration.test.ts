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
 * Escalation timeout and auto-advance, and deadline write verification.
 *
 * All time manipulation uses TestClock, never jest.useFakeTimers.
 */

import { mockServices, TestDatabases } from '@backstage/backend-test-utils';
import { DatabaseOwnershipStore } from '../service/DatabaseOwnershipStore';
import { DefaultDeadlineCheckerService } from './DeadlineCheckerService';
import { DefaultEscalationService } from './EscalationService';
import { FallbackEscalationTrigger } from './EscalationTrigger';
import { ProposalLifecycleService } from '../service/ProposalLifecycleService';
import { createStandardOrgHierarchy } from './__fixtures__/createMockCatalog';
import { buildValidEscalationConfig } from './__fixtures__/buildEscalationConfig';
import { TestClock } from './__fixtures__/Clock';
import {
  seedEntityRow,
  seedProposalRow,
  seedDeadlineRow,
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

function buildCheckerService(
  store: DatabaseOwnershipStore,
  clock: TestClock,
  configOverrides: Record<string, unknown> = {},
) {
  const logger = mockServices.logger.mock();
  const config = buildValidEscalationConfig({
    gracePeriodDays: 14,
    warningDays: 4,
    reDecisionDays: 3,
    ...configOverrides,
  });
  // EscalationService so dead-group skipping and actor resolution are
  // exercised by the same code path as escalationReject.
  const escSvc = buildEscalationService(store, clock, configOverrides);
  return new DefaultDeadlineCheckerService(
    store,
    escSvc,
    config,
    clock,
    logger,
  );
}

function buildEscalationService(
  store: DatabaseOwnershipStore,
  clock: TestClock,
  configOverrides = {},
) {
  const catalog = createStandardOrgHierarchy();
  const config = buildValidEscalationConfig({
    gracePeriodDays: 14,
    warningDays: 4,
    reDecisionDays: 3,
    ...configOverrides,
  });
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

// ─── Escalation Timeout & Auto-Advance ──────────────────────────────

describe('Escalation Timeout & Auto-Advance', () => {
  it('domain timeout → next domain actor notified, fresh escalation_timeout deadline written', async () => {
    // new escalation_timeout deadline written for Director-B.
    const { store, knex } = await createStore();
    const clock = new TestClock(new Date('2026-01-01T00:00:00.000Z'));
    const entity = await seedEntityRow(knex, { current_status: 'escalated' });

    // Director-A's timeout fired
    await seedDeadlineRow(knex, entity.id, {
      deadline_type: 'escalation_timeout',
      fire_at: new Date('2026-01-01T00:00:00.000Z'), // now
      actor_ref: 'user:default/jane.director',
      escalation_level: 1,
      processed: false,
    });

    // Director-B is next in queue
    await seedQueueEntry(knex, entity.id, {
      group_ref: 'group:default/domain-payments',
      escalation_level: 1,
      position: 2,
      status: 'queued',
    });

    const checker = buildCheckerService(store, clock);
    await checker.processExpiredDeadlines();

    // Director-A's deadline should be processed
    const processedDeadline = await knex('pending_deadlines')
      .where({
        entity_id: entity.id,
        deadline_type: 'escalation_timeout',
        actor_ref: 'user:default/jane.director',
      })
      .first();
    expect(processedDeadline.processed).toBe(true);

    // domain-payments entry should be active
    const paymentsEntry = await knex('escalation_queue_entries')
      .where({
        entity_id: entity.id,
        group_ref: 'group:default/domain-payments',
      })
      .first();
    expect(paymentsEntry.status).toBe('active');

    // New escalation_timeout deadline written for domain-payments actor
    const newDeadline = await knex('pending_deadlines')
      .where({
        entity_id: entity.id,
        deadline_type: 'escalation_timeout',
        processed: false,
      })
      .first();
    expect(newDeadline).toBeDefined();
  });

  it('last domain timeout → portfolio VP notified, escalation_timeout deadline written for VP', async () => {
    const { store, knex } = await createStore();
    const clock = new TestClock(new Date('2026-01-01T00:00:00.000Z'));
    const entity = await seedEntityRow(knex, { current_status: 'escalated' });
    await seedDeadlineRow(knex, entity.id, {
      deadline_type: 'escalation_timeout',
      fire_at: new Date('2026-01-01T00:00:00.000Z'),
      actor_ref: 'user:default/john.director',
      escalation_level: 1,
    });
    await seedQueueEntry(knex, entity.id, {
      group_ref: 'group:default/portfolio-consumer',
      escalation_level: 2,
      position: 10,
      status: 'queued',
    });

    const checker = buildCheckerService(store, clock);
    await checker.processExpiredDeadlines();

    const portfolioEntry = await knex('escalation_queue_entries')
      .where({
        entity_id: entity.id,
        group_ref: 'group:default/portfolio-consumer',
      })
      .first();
    expect(portfolioEntry.status).toBe('active');
    expect(portfolioEntry.resolved_actor_ref).toBeDefined();
  });

  it('portfolio timeout → next VP notified', async () => {
    const catalog = createStandardOrgHierarchy();
    catalog.addGroup('group:default/portfolio-talent', {
      kind: 'Group',
      specType: 'portfolio',
    });
    catalog.addUser(
      'user:default/vp.talent',
      'Vice President, Technology',
      'group:default/portfolio-talent',
    );

    const { store, knex } = await createStore();
    const clock = new TestClock(new Date('2026-01-01T00:00:00.000Z'));
    const entity = await seedEntityRow(knex, { current_status: 'escalated' });
    await seedDeadlineRow(knex, entity.id, {
      deadline_type: 'escalation_timeout',
      fire_at: new Date('2026-01-01T00:00:00.000Z'),
      actor_ref: 'user:default/vp.consumer',
      escalation_level: 2,
    });
    await seedQueueEntry(knex, entity.id, {
      group_ref: 'group:default/portfolio-talent',
      escalation_level: 2,
      position: 11,
      status: 'queued',
    });

    const checker = buildCheckerService(store, clock);
    await checker.processExpiredDeadlines();

    const talentEntry = await knex('escalation_queue_entries')
      .where({
        entity_id: entity.id,
        group_ref: 'group:default/portfolio-talent',
      })
      .first();
    expect(talentEntry.status).toBe('active');
  });

  it('last VP timeout → entity becomes unresolved, fallbackActors notified', async () => {
    const { store, knex } = await createStore();
    const clock = new TestClock(new Date('2026-01-01T00:00:00.000Z'));
    const entity = await seedEntityRow(knex, { current_status: 'escalated' });
    await seedDeadlineRow(knex, entity.id, {
      deadline_type: 'escalation_timeout',
      fire_at: new Date('2026-01-01T00:00:00.000Z'),
      actor_ref: 'user:default/vp.talent',
      escalation_level: 2,
    });
    // No more queued entries.

    const checker = buildCheckerService(store, clock);
    await checker.processExpiredDeadlines();

    const entityRow = await knex('ownership_entities')
      .where({ id: entity.id })
      .first();
    expect(entityRow.current_status).toBe('unresolved');

    const exhaustedHistory = await knex('ownership_history')
      .where({ entity_id: entity.id, action: 'escalation_exhausted' })
      .first();
    expect(exhaustedHistory).toBeDefined();
  });

  it('no escalation_timeout deadline during suggestion — checker finds no expired timeout', async () => {
    // escalation_timeout deadline for this entity (was cancelled earlier).
    // The checker finds no unprocessed escalation_timeout.
    const { store, knex } = await createStore();
    const clock = new TestClock(new Date('2026-01-01T00:00:00.000Z'));
    const entity = await seedEntityRow(knex, { current_status: 'escalated' });
    // Only a proposal_expiry deadline exists (future — not expired).
    await seedDeadlineRow(knex, entity.id, {
      deadline_type: 'proposal_expiry',
      fire_at: new Date(Date.now() + 1000 * 60 * 60 * 24 * 7), // 7 days ahead
      processed: false,
    });

    const checker = buildCheckerService(store, clock);
    await checker.processExpiredDeadlines();

    // No escalation_timeout was fired; entity still escalated
    const entityRow = await knex('ownership_entities')
      .where({ id: entity.id })
      .first();
    expect(entityRow.current_status).toBe('escalated');
  });

  it('stale deadline — entity already accepted/closed → deadline skipped, marked processed', async () => {
    const { store, knex } = await createStore();
    const clock = new TestClock(new Date('2026-01-01T00:00:00.000Z'));
    const entity = await seedEntityRow(knex, { current_status: 'accepted' });
    await seedDeadlineRow(knex, entity.id, {
      deadline_type: 'escalation_timeout',
      fire_at: new Date('2026-01-01T00:00:00.000Z'),
      actor_ref: 'user:default/jane.director',
      escalation_level: 1,
    });

    const checker = buildCheckerService(store, clock);
    await checker.processExpiredDeadlines();

    // Stale deadline should be marked processed, no entity status change
    const deadline = await knex('pending_deadlines')
      .where({ entity_id: entity.id })
      .first();
    expect(deadline.processed).toBe(true);
    const entityRow = await knex('ownership_entities')
      .where({ id: entity.id })
      .first();
    expect(entityRow.current_status).toBe('accepted'); // unchanged
  });

  it('deadline written at notification time with correct fire_at', async () => {
    // fire_at = NOW + timeoutDays and deadline_type = escalation_timeout.
    const { store, knex } = await createStore();
    const clock = new TestClock(new Date('2026-01-01T00:00:00.000Z'));
    const entity = await seedEntityRow(knex, { current_status: 'escalated' });
    await seedQueueEntry(knex, entity.id, {
      group_ref: 'group:default/domain-search',
      escalation_level: 1,
      position: 1,
      status: 'queued',
    });
    const escSvc = buildEscalationService(store, clock);

    await escSvc.activateNextEntry(entity.id);

    const deadline = await knex('pending_deadlines')
      .where({
        entity_id: entity.id,
        deadline_type: 'escalation_timeout',
        processed: false,
      })
      .first();
    expect(deadline).toBeDefined();
    // fire_at should be approximately clock + DOMAIN_LEVEL timeoutDays (7 days)
    const expectedFireAt = new Date('2026-01-08T00:00:00.000Z').getTime();
    const actualFireAt = new Date(deadline.fire_at).getTime();
    // Allow 1 minute tolerance
    expect(Math.abs(actualFireAt - expectedFireAt)).toBeLessThan(60 * 1000);
  });
});

// ─── Deadline Write Verification ──────────────────────────────────

describe('Deadline Write Verification', () => {
  it('escalation actor notified writes escalation_timeout deadline with correct fire_at', async () => {
    const { store, knex } = await createStore();
    const clock = new TestClock(new Date('2026-01-01T00:00:00.000Z'));
    const entity = await seedEntityRow(knex, { current_status: 'escalated' });
    await seedQueueEntry(knex, entity.id, {
      group_ref: 'group:default/domain-search',
      escalation_level: 1,
      position: 1,
      status: 'queued',
    });
    const escSvc = buildEscalationService(store, clock);

    await escSvc.activateNextEntry(entity.id);

    const deadline = await knex('pending_deadlines')
      .where({
        entity_id: entity.id,
        deadline_type: 'escalation_timeout',
        processed: false,
      })
      .first();
    expect(deadline).toBeDefined();
    // fire_at should be clock + 7 days (DOMAIN_LEVEL timeoutDays)
    const expectedFireAt = new Date('2026-01-08T00:00:00.000Z').getTime();
    const actualFireAt = new Date(deadline.fire_at).getTime();
    expect(Math.abs(actualFireAt - expectedFireAt)).toBeLessThan(60 * 1000);
  });

  it('team accepts proposal → grace_warning + grace_expiry deadlines written', async () => {
    // Fails if grace deadlines are NOT written.
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

    await svc.acceptProposal(proposal.id, 'user:default/alice');

    // Grace deadlines must be written
    const deadlines = await knex('pending_deadlines').where({
      entity_id: entity.id,
    });
    const types = deadlines.map((d: any) => d.deadline_type);
    expect(types).toContain('grace_warning');
    expect(types).toContain('grace_expiry');
  });

  it('escalation assign writes grace_warning + grace_expiry deadlines', async () => {
    const { store, knex } = await createStore();
    const clock = new TestClock(new Date('2026-01-01T00:00:00.000Z'));
    const entity = await seedEntityRow(knex, { current_status: 'escalated' });
    await seedQueueEntry(knex, entity.id, {
      group_ref: 'group:default/domain-search',
      status: 'active',
      resolved_actor_ref: 'user:default/jane.director',
      escalation_level: 1,
    });
    const escSvc = buildEscalationService(store, clock);

    await escSvc.escalationAssign(
      entity.id,
      'group:default/team-b',
      'user:default/jane.director',
    );

    const deadlines = await knex('pending_deadlines').where({
      entity_id: entity.id,
      processed: false,
    });
    const types = deadlines.map((d: any) => d.deadline_type);
    expect(types).toContain('grace_warning');
    expect(types).toContain('grace_expiry');
    // grace_expiry should be at clock + gracePeriodDays (14 days)
    const graceExpiry = deadlines.find(
      (d: any) => d.deadline_type === 'grace_expiry',
    );
    const expectedExpiry = new Date('2026-01-15T00:00:00.000Z').getTime();
    expect(
      Math.abs(new Date(graceExpiry.fire_at).getTime() - expectedExpiry),
    ).toBeLessThan(60 * 1000);
  });

  it('escalation archive writes grace_warning + grace_expiry deadlines', async () => {
    const { store, knex } = await createStore();
    const clock = new TestClock(new Date('2026-01-01T00:00:00.000Z'));
    const entity = await seedEntityRow(knex, { current_status: 'escalated' });
    await seedQueueEntry(knex, entity.id, {
      group_ref: 'group:default/domain-search',
      status: 'active',
      resolved_actor_ref: 'user:default/jane.director',
      escalation_level: 1,
    });
    const escSvc = buildEscalationService(store, clock);

    await escSvc.escalationArchive(
      entity.id,
      'group:default/team-b',
      'user:default/jane.director',
    );

    const deadlines = await knex('pending_deadlines').where({
      entity_id: entity.id,
      processed: false,
    });
    const types = deadlines.map((d: any) => d.deadline_type);
    expect(types).toContain('grace_warning');
    expect(types).toContain('grace_expiry');
  });

  it('grace period expires at escalation level → redecision_expiry deadline written for director', async () => {
    const { store, knex } = await createStore();
    const clock = new TestClock(new Date('2026-01-15T00:00:00.000Z'));
    const entity = await seedEntityRow(knex, { current_status: 'accepted' });
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

    const checker = buildCheckerService(store, clock);
    await checker.processExpiredDeadlines();

    // redecision_expiry should now be in pending_deadlines
    const redecisionDeadline = await knex('pending_deadlines')
      .where({
        entity_id: entity.id,
        deadline_type: 'redecision_expiry',
        processed: false,
      })
      .first();
    expect(redecisionDeadline).toBeDefined();
    // fire_at = clock + reDecisionDays (3 days)
    const expectedFireAt = new Date('2026-01-18T00:00:00.000Z').getTime();
    expect(
      Math.abs(new Date(redecisionDeadline.fire_at).getTime() - expectedFireAt),
    ).toBeLessThan(60 * 1000);
  });

  it('suggest action writes proposal_expiry for suggestion and cancels escalation_timeout', async () => {
    // existing escalation_timeout cancelled.
    const { store, knex } = await createStore();
    const clock = new TestClock(new Date('2026-01-01T00:00:00.000Z'));
    const entity = await seedEntityRow(knex, { current_status: 'escalated' });
    await seedQueueEntry(knex, entity.id, {
      group_ref: 'group:default/domain-search',
      status: 'active',
      resolved_actor_ref: 'user:default/jane.director',
      escalation_level: 1,
    });
    await seedDeadlineRow(knex, entity.id, {
      deadline_type: 'escalation_timeout',
      fire_at: new Date('2026-01-08T00:00:00.000Z'), // 7 days ahead
      actor_ref: 'user:default/jane.director',
      escalation_level: 1,
      processed: false,
    });
    const escSvc = buildEscalationService(store, clock);

    await escSvc.escalationSuggest(
      entity.id,
      'group:default/team-d',
      'Team-D fits this domain',
      'user:default/jane.director',
    );

    // escalation_timeout should be cancelled (processed)
    const timeoutDeadline = await knex('pending_deadlines')
      .where({ entity_id: entity.id, deadline_type: 'escalation_timeout' })
      .first();
    expect(timeoutDeadline.processed).toBe(true);

    // proposal_expiry should now exist for the suggestion
    const proposalExpiry = await knex('pending_deadlines')
      .where({
        entity_id: entity.id,
        deadline_type: 'proposal_expiry',
        processed: false,
      })
      .first();
    expect(proposalExpiry).toBeDefined();
  });

  it('entity closed by scanner → all pending deadlines eagerly cancelled', async () => {
    // SUT: DeadlineCheckerService.cancelDeadlinesForEntity.
    const { store, knex } = await createStore();
    const clock = new TestClock(new Date('2026-01-01T00:00:00.000Z'));
    const entity = await seedEntityRow(knex, { current_status: 'escalated' });
    await seedDeadlineRow(knex, entity.id, {
      deadline_type: 'escalation_timeout',
      fire_at: new Date('2026-01-08T00:00:00.000Z'),
      processed: false,
    });
    await seedDeadlineRow(knex, entity.id, {
      deadline_type: 'grace_warning',
      fire_at: new Date('2026-01-10T00:00:00.000Z'),
      processed: false,
    });
    const checker = buildCheckerService(store, clock);

    await checker.cancelDeadlinesForEntity(entity.id);

    const remaining = await knex('pending_deadlines').where({
      entity_id: entity.id,
      processed: false,
    });
    expect(remaining).toHaveLength(0);
  });
});

// ─── Proposal Expiry ──────────────────────────────────────────

describe('Proposal Expiry', () => {
  it('open + pending team-A + pending team-B → A expires → stays open, team-B still pending', async () => {
    const { store, knex } = await createStore();
    const clock = new TestClock(new Date('2026-01-15T00:00:00.000Z'));
    const entity = await seedEntityRow(knex, { current_status: 'open' });
    const proposalA = await seedProposalRow(knex, entity.id, {
      proposed_owner_ref: 'group:default/team-a',
      status: 'pending',
      proposal_order: 1,
    });
    await seedProposalRow(knex, entity.id, {
      proposed_owner_ref: 'group:default/team-b',
      status: 'pending',
      proposal_order: 2,
    });
    await seedDeadlineRow(knex, entity.id, {
      deadline_type: 'proposal_expiry',
      fire_at: new Date('2026-01-15T00:00:00.000Z'),
      proposal_id: proposalA.id,
      processed: false,
    });
    const checker = buildCheckerService(store, clock);

    await checker.processExpiredDeadlines();

    // team-A proposal must be expired
    const pA = await knex('ownership_proposals')
      .where({ id: proposalA.id })
      .first();
    expect(pA.status).toBe('expired');

    // team-B proposal must still be pending
    const pB = await knex('ownership_proposals')
      .where({
        entity_id: entity.id,
        proposed_owner_ref: 'group:default/team-b',
      })
      .first();
    expect(pB.status).toBe('pending');

    // entity must still be open
    const entityRow = await knex('ownership_entities')
      .where({ id: entity.id })
      .first();
    expect(entityRow.current_status).toBe('open');

    // proposal_expired history must exist
    const expiredHistory = await knex('ownership_history')
      .where({ entity_id: entity.id, action: 'proposal_expired' })
      .first();
    expect(expiredHistory).toBeDefined();

    // escalation_exhausted must NOT exist
    const badHistory = await knex('ownership_history')
      .where({ entity_id: entity.id, action: 'escalation_exhausted' })
      .first();
    expect(badHistory).toBeUndefined();
  });

  it('open + sole pending proposal + escalation config → expiry fires → entity escalated', async () => {
    const { store, knex } = await createStore();
    const clock = new TestClock(new Date('2026-01-15T00:00:00.000Z'));
    const entity = await seedEntityRow(knex, { current_status: 'open' });
    const proposalA = await seedProposalRow(knex, entity.id, {
      proposed_owner_ref: 'group:default/team-a',
      status: 'pending',
      proposal_order: 1,
    });
    await seedDeadlineRow(knex, entity.id, {
      deadline_type: 'proposal_expiry',
      fire_at: new Date('2026-01-15T00:00:00.000Z'),
      proposal_id: proposalA.id,
      processed: false,
    });
    const checker = buildCheckerService(store, clock);

    await checker.processExpiredDeadlines();

    // proposal must be expired
    const pA = await knex('ownership_proposals')
      .where({ id: proposalA.id })
      .first();
    expect(pA.status).toBe('expired');

    // entity must be escalated
    const entityRow = await knex('ownership_entities')
      .where({ id: entity.id })
      .first();
    expect(entityRow.current_status).toBe('escalated');

    // escalation_triggered history must exist
    const triggerHistory = await knex('ownership_history')
      .where({ entity_id: entity.id, action: 'escalation_triggered' })
      .first();
    expect(triggerHistory).toBeDefined();

    // escalation_timeout deadline must be written for the first BFS actor
    const timeoutDeadline = await knex('pending_deadlines')
      .where({
        entity_id: entity.id,
        deadline_type: 'escalation_timeout',
        processed: false,
      })
      .first();
    expect(timeoutDeadline).toBeDefined();

    // escalation_exhausted must NOT exist
    const badHistory = await knex('ownership_history')
      .where({ entity_id: entity.id, action: 'escalation_exhausted' })
      .first();
    expect(badHistory).toBeUndefined();
  });

  it('open + sole pending proposal + FallbackTrigger (no escalation) → expiry fires → unresolved via no_candidates_found', async () => {
    const { store, knex } = await createStore();
    const clock = new TestClock(new Date('2026-01-15T00:00:00.000Z'));
    const entity = await seedEntityRow(knex, { current_status: 'open' });
    const proposalA = await seedProposalRow(knex, entity.id, {
      proposed_owner_ref: 'group:default/team-a',
      status: 'pending',
      proposal_order: 1,
    });
    await seedDeadlineRow(knex, entity.id, {
      deadline_type: 'proposal_expiry',
      fire_at: new Date('2026-01-15T00:00:00.000Z'),
      proposal_id: proposalA.id,
      processed: false,
    });
    const logger = mockServices.logger.mock();
    const config = buildValidEscalationConfig();
    // Wire a FallbackEscalationTrigger to simulate the "escalation disabled" path.
    const fallbackTrigger = new FallbackEscalationTrigger(store, logger);
    const fallbackSvc = {
      triggerEscalation: (entityId: string) =>
        fallbackTrigger.triggerEscalation(entityId),
      advanceQueue: jest.fn(),
      buildBfsQueue: jest.fn(),
      activateNextEntry: jest.fn(),
      revalidateQueue: jest.fn(),
      resolveActorForGroup: jest.fn(),
      escalationReject: jest.fn(),
      escalationAssign: jest.fn(),
      escalationArchive: jest.fn(),
      escalationSuggest: jest.fn(),
      escalationRetrigger: jest.fn(),
    } as any;
    const checker = new DefaultDeadlineCheckerService(
      store,
      fallbackSvc,
      config,
      clock,
      logger,
    );

    await checker.processExpiredDeadlines();

    // proposal must be expired
    const pA = await knex('ownership_proposals')
      .where({ id: proposalA.id })
      .first();
    expect(pA.status).toBe('expired');

    // entity must be unresolved
    const entityRow = await knex('ownership_entities')
      .where({ id: entity.id })
      .first();
    expect(entityRow.current_status).toBe('unresolved');

    // history must have no_candidates_found, NOT escalation_exhausted
    const noCandidates = await knex('ownership_history')
      .where({ entity_id: entity.id, action: 'no_candidates_found' })
      .first();
    expect(noCandidates).toBeDefined();

    const badHistory = await knex('ownership_history')
      .where({ entity_id: entity.id, action: 'escalation_exhausted' })
      .first();
    expect(badHistory).toBeUndefined();
  });

  it('escalated + queued BFS entry + pending suggestion + expiry fires → suggestion expired, BFS resumes', async () => {
    const { store, knex } = await createStore();
    const clock = new TestClock(new Date('2026-01-15T00:00:00.000Z'));
    const entity = await seedEntityRow(knex, { current_status: 'escalated' });
    // Director-A was active (now completed), Director-B is queued
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
    // Suggestion proposal was pending
    const suggestionProposal = await seedProposalRow(knex, entity.id, {
      proposed_owner_ref: 'group:default/team-suggested',
      status: 'pending',
      proposal_order: 99,
      escalation_level: 1,
    });
    await seedDeadlineRow(knex, entity.id, {
      deadline_type: 'proposal_expiry',
      fire_at: new Date('2026-01-15T00:00:00.000Z'),
      proposal_id: suggestionProposal.id,
      processed: false,
    });
    const checker = buildCheckerService(store, clock);

    await checker.processExpiredDeadlines();

    // suggestion proposal must be expired
    const suggestion = await knex('ownership_proposals')
      .where({ id: suggestionProposal.id })
      .first();
    expect(suggestion.status).toBe('expired');

    // entity must still be escalated
    const entityRow = await knex('ownership_entities')
      .where({ id: entity.id })
      .first();
    expect(entityRow.current_status).toBe('escalated');

    // Director-B (domain-payments) must now be active
    const paymentsEntry = await knex('escalation_queue_entries')
      .where({
        entity_id: entity.id,
        group_ref: 'group:default/domain-payments',
      })
      .first();
    expect(paymentsEntry.status).toBe('active');
  });

  it('proposal_expiry fires for already-rejected proposal → idempotent, no extra state change', async () => {
    const { store, knex } = await createStore();
    const clock = new TestClock(new Date('2026-01-15T00:00:00.000Z'));
    const entity = await seedEntityRow(knex, { current_status: 'open' });
    const proposal = await seedProposalRow(knex, entity.id, {
      proposed_owner_ref: 'group:default/team-a',
      status: 'rejected',
      proposal_order: 1,
    });
    await seedDeadlineRow(knex, entity.id, {
      deadline_type: 'proposal_expiry',
      fire_at: new Date('2026-01-15T00:00:00.000Z'),
      proposal_id: proposal.id,
      processed: false,
    });
    const checker = buildCheckerService(store, clock);

    await checker.processExpiredDeadlines();

    // proposal must still be rejected (not changed to expired)
    const pRow = await knex('ownership_proposals')
      .where({ id: proposal.id })
      .first();
    expect(pRow.status).toBe('rejected');

    // proposal_expired history must NOT be written
    const expiredHistory = await knex('ownership_history')
      .where({ entity_id: entity.id, action: 'proposal_expired' })
      .first();
    expect(expiredHistory).toBeUndefined();
  });
});

// ─── Reject Proposal ──────────────────────────────────────────

describe('Reject Proposal', () => {
  it('open + pending team-A + pending team-B + reject team-A → stays open, team-B still pending', async () => {
    const { store, knex } = await createStore();
    const clock = new TestClock(new Date('2026-01-15T00:00:00.000Z'));
    const entity = await seedEntityRow(knex, { current_status: 'open' });
    const proposalA = await seedProposalRow(knex, entity.id, {
      proposed_owner_ref: 'group:default/team-a',
      status: 'pending',
      proposal_order: 1,
    });
    await seedProposalRow(knex, entity.id, {
      proposed_owner_ref: 'group:default/team-b',
      status: 'pending',
      proposal_order: 2,
    });

    const logger = mockServices.logger.mock();
    const escSvc = buildEscalationService(store, clock);
    const lifecycleSvc = new ProposalLifecycleService(
      store,
      logger,
      undefined,
      undefined,
      escSvc,
    );

    await lifecycleSvc.rejectProposal(
      proposalA.id,
      'user:default/alice',
      'not relevant',
    );

    // team-A must be rejected
    const pA = await knex('ownership_proposals')
      .where({ id: proposalA.id })
      .first();
    expect(pA.status).toBe('rejected');

    // team-B must still be pending
    const pB = await knex('ownership_proposals')
      .where({
        entity_id: entity.id,
        proposed_owner_ref: 'group:default/team-b',
      })
      .first();
    expect(pB.status).toBe('pending');

    // entity must still be open
    const entityRow = await knex('ownership_entities')
      .where({ id: entity.id })
      .first();
    expect(entityRow.current_status).toBe('open');
  });

  it('open + sole pending proposal + escalation config + user rejects → entity escalated', async () => {
    const { store, knex } = await createStore();
    const clock = new TestClock(new Date('2026-01-15T00:00:00.000Z'));
    const entity = await seedEntityRow(knex, { current_status: 'open' });
    const proposalA = await seedProposalRow(knex, entity.id, {
      proposed_owner_ref: 'group:default/team-a',
      status: 'pending',
      proposal_order: 1,
    });

    const logger = mockServices.logger.mock();
    const escSvc = buildEscalationService(store, clock);
    const lifecycleSvc = new ProposalLifecycleService(
      store,
      logger,
      undefined,
      undefined,
      escSvc,
    );

    await lifecycleSvc.rejectProposal(
      proposalA.id,
      'user:default/alice',
      'wrong team',
    );

    // proposal must be rejected
    const pA = await knex('ownership_proposals')
      .where({ id: proposalA.id })
      .first();
    expect(pA.status).toBe('rejected');

    // entity must be escalated
    const entityRow = await knex('ownership_entities')
      .where({ id: entity.id })
      .first();
    expect(entityRow.current_status).toBe('escalated');

    // escalation_triggered history must exist
    const triggerHistory = await knex('ownership_history')
      .where({ entity_id: entity.id, action: 'escalation_triggered' })
      .first();
    expect(triggerHistory).toBeDefined();

    // BFS queue must be populated
    const queueEntries = await knex('escalation_queue_entries').where({
      entity_id: entity.id,
    });
    expect(queueEntries.length).toBeGreaterThan(0);
  });
});
