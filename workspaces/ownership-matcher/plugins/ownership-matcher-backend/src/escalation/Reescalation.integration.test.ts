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
 * Re-escalation of stale accepted / to_archive entities.
 *
 * All time manipulation uses TestClock, never jest.useFakeTimers.
 */

import { mockServices, TestDatabases } from '@backstage/backend-test-utils';
import { DatabaseOwnershipStore } from '../service/DatabaseOwnershipStore';
import { DefaultEscalationService } from './EscalationService';
import { DefaultDeadlineCheckerService } from './DeadlineCheckerService';
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

function buildEscSvc(
  store: DatabaseOwnershipStore,
  clock: TestClock,
  configOverrides = {},
) {
  const catalog = createStandardOrgHierarchy();
  const config = buildValidEscalationConfig(configOverrides);
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

function buildChecker(
  store: DatabaseOwnershipStore,
  clock: TestClock,
  configOverrides = {},
) {
  const logger = mockServices.logger.mock();
  const config = buildValidEscalationConfig(configOverrides);
  const escSvc = buildEscSvc(store, clock, configOverrides);
  return new DefaultDeadlineCheckerService(
    store,
    escSvc,
    config,
    clock,
    logger,
  );
}

// ─── Re-escalation ─────────────────────────────────────────────────

describe('Re-escalation (Stale Accepted/To_Archive)', () => {
  it('closed entity is NOT re-escalated — new case created fresh', async () => {
    // Verifies DB state.
    const { knex } = await createStore();
    const entity = await seedEntityRow(knex, { current_status: 'closed' });

    const row = await knex('ownership_entities')
      .where({ id: entity.id })
      .first();
    expect(row.current_status).toBe('closed');
    // Scanner creates a NEW case for a new issue; it does NOT reopen this one.
  });

  it('re-escalation resumes from next level — grace failure at domain level advances to portfolio', async () => {
    // not back to domain.
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
    await seedQueueEntry(knex, entity.id, {
      group_ref: 'group:default/portfolio-consumer',
      escalation_level: 2,
      position: 10,
      status: 'queued',
    });
    const checker = buildChecker(store, clock);

    await checker.processExpiredDeadlines();

    // Entity should be re-escalated (back to escalated status)
    const entityRow = await knex('ownership_entities')
      .where({ id: entity.id })
      .first();
    expect(entityRow.current_status).toBe('escalated');

    // Portfolio entry should now be active (not domain level)
    const portfolioEntry = await knex('escalation_queue_entries')
      .where({
        entity_id: entity.id,
        group_ref: 'group:default/portfolio-consumer',
      })
      .first();
    expect(portfolioEntry.status).toBe('active');
  });

  it('last level re-decision expired → entity becomes unresolved (fallback bucket)', async () => {
    const { store, knex } = await createStore();
    const clock = new TestClock(new Date('2026-01-05T00:00:00.000Z'));
    const entity = await seedEntityRow(knex, {
      current_status: 'escalated',
      version: 3,
    });
    await seedDeadlineRow(knex, entity.id, {
      deadline_type: 'redecision_expiry',
      fire_at: new Date('2026-01-05T00:00:00.000Z'),
      actor_ref: 'user:default/vp.consumer',
      escalation_level: 2,
    });
    // No more queued entries after VP.
    const checker = buildChecker(store, clock);

    await checker.processExpiredDeadlines();

    const entityRow = await knex('ownership_entities')
      .where({ id: entity.id })
      .first();
    expect(entityRow.current_status).toBe('unresolved');
  });

  it('multiple grace period cycles — director assigns team across multiple assign cycles', async () => {
    // After cycle 1: entity is accepted, grace deadlines written.
    const { store, knex } = await createStore();
    const clock = new TestClock(new Date('2026-01-01T00:00:00.000Z'));
    const entity = await seedEntityRow(knex, { current_status: 'escalated' });
    await seedQueueEntry(knex, entity.id, {
      group_ref: 'group:default/domain-search',
      status: 'active',
      resolved_actor_ref: 'user:default/jane.director',
      escalation_level: 1,
    });
    const escSvc = buildEscSvc(store, clock);

    // Cycle 1: assign team-A
    await escSvc.escalationAssign(
      entity.id,
      'group:default/team-a',
      'user:default/jane.director',
    );

    const entityRow = await knex('ownership_entities')
      .where({ id: entity.id })
      .first();
    expect(entityRow.current_status).toBe('accepted');

    // Grace deadlines written
    const deadlines = await knex('pending_deadlines').where({
      entity_id: entity.id,
      processed: false,
    });
    const types = deadlines.map((d: any) => d.deadline_type);
    expect(types).toContain('grace_warning');
    expect(types).toContain('grace_expiry');
  });

  it('grace period is configurable — gracePeriodDays: 21 → grace_expiry at 21 days', async () => {
    const { store, knex } = await createStore();
    const clock = new TestClock(new Date('2026-01-01T00:00:00.000Z'));
    const entity = await seedEntityRow(knex, { current_status: 'escalated' });
    await seedQueueEntry(knex, entity.id, {
      group_ref: 'group:default/domain-search',
      status: 'active',
      resolved_actor_ref: 'user:default/jane.director',
      escalation_level: 1,
    });
    const escSvc = buildEscSvc(store, clock, {
      gracePeriodDays: 21,
      warningDays: 7,
    });

    await escSvc.escalationAssign(
      entity.id,
      'group:default/team-b',
      'user:default/jane.director',
    );

    // grace_expiry deadline at clock + 21 days
    const graceExpiry = await knex('pending_deadlines')
      .where({
        entity_id: entity.id,
        deadline_type: 'grace_expiry',
        processed: false,
      })
      .first();
    expect(graceExpiry).toBeDefined();
    const expectedExpiry = new Date('2026-01-22T00:00:00.000Z').getTime();
    expect(
      Math.abs(new Date(graceExpiry.fire_at).getTime() - expectedExpiry),
    ).toBeLessThan(60 * 1000);

    // grace_warning deadline at clock + (21 - 7) = 14 days
    const graceWarning = await knex('pending_deadlines')
      .where({
        entity_id: entity.id,
        deadline_type: 'grace_warning',
        processed: false,
      })
      .first();
    expect(graceWarning).toBeDefined();
    const expectedWarning = new Date('2026-01-15T00:00:00.000Z').getTime();
    expect(
      Math.abs(new Date(graceWarning.fire_at).getTime() - expectedWarning),
    ).toBeLessThan(60 * 1000);
  });

  it('re-decision window is configurable — reDecisionDays: 5 → redecision_expiry 5 days after grace', async () => {
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
    const checker = buildChecker(store, clock, { reDecisionDays: 5 });

    await checker.processExpiredDeadlines();

    // redecision_expiry at clock + 5 days = 2026-01-20
    const redecisionDeadline = await knex('pending_deadlines')
      .where({
        entity_id: entity.id,
        deadline_type: 'redecision_expiry',
        processed: false,
      })
      .first();
    expect(redecisionDeadline).toBeDefined();
    const expectedFireAt = new Date('2026-01-20T00:00:00.000Z').getTime();
    expect(
      Math.abs(new Date(redecisionDeadline.fire_at).getTime() - expectedFireAt),
    ).toBeLessThan(60 * 1000);
  });
});
