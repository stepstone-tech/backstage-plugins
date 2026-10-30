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
 * Activating an escalation queue entry must notify the resolved actor (a user)
 * via the `EscalationAssigned` event, not only write `escalation_notified`
 * history.
 */

import { mockServices, TestDatabases } from '@backstage/backend-test-utils';
import { EventsService } from '@backstage/plugin-events-node';
import { DatabaseOwnershipStore } from '../service/DatabaseOwnershipStore';
import { NotificationsTopic } from '../service/notifications/topics';
import { DefaultEscalationService } from './EscalationService';
import { createStandardOrgHierarchy } from './__fixtures__/createMockCatalog';
import { buildValidEscalationConfig } from './__fixtures__/buildEscalationConfig';
import { TestClock } from './__fixtures__/Clock';
import {
  seedEntityRow,
  seedProposalRow,
  seedQueueEntry,
} from './__fixtures__/seedEntity';

const databases = TestDatabases.create({ ids: ['POSTGRES_16'] });

async function setup(
  publish: jest.Mock = jest.fn().mockResolvedValue(undefined),
) {
  const knex = await databases.init('POSTGRES_16');
  const store = await DatabaseOwnershipStore.create({
    database: {
      getClient: async () => knex,
      migrations: { skip: false },
    } as any,
  });
  const events = { publish, subscribe: jest.fn() } as unknown as EventsService;
  const logger = mockServices.logger.mock();
  const svc = new DefaultEscalationService(
    store,
    createStandardOrgHierarchy(),
    buildValidEscalationConfig(),
    new TestClock(),
    { runScan: jest.fn(), scanEntity: jest.fn() } as any,
    { generateProposalsForEntity: jest.fn().mockResolvedValue(0) } as any,
    logger,
    events,
  );
  return { knex, svc, publish, logger };
}

describe('Escalation notification (EscalationAssigned)', () => {
  it('publishes EscalationAssigned to the resolved actor with the case details', async () => {
    const { knex, svc, publish } = await setup();
    const entity = await seedEntityRow(knex, { current_status: 'escalated' });
    await seedProposalRow(knex, entity.id, {
      proposed_owner_ref: 'group:default/team-a',
      status: 'rejected',
      proposal_order: 1,
    });
    await seedQueueEntry(knex, entity.id, {
      group_ref: 'group:default/portfolio-consumer',
      escalation_level: 2,
      position: 10,
      status: 'queued',
    });

    await svc.activateNextEntry(entity.id);

    const active = await knex('escalation_queue_entries')
      .where({ entity_id: entity.id, status: 'active' })
      .first();
    expect(active.resolved_actor_ref).toBeTruthy();
    const row = await knex('ownership_entities')
      .where({ id: entity.id })
      .first();

    const calls = publish.mock.calls.filter(
      ([e]) => e.topic === NotificationsTopic.EscalationAssigned,
    );
    expect(calls).toHaveLength(1);
    expect(calls[0][0].eventPayload).toEqual({
      entityId: entity.id,
      entityName: row.entity_name,
      entityRef: row.entity_ref,
      actorRef: active.resolved_actor_ref,
      groupRef: 'group:default/portfolio-consumer',
      level: 2,
    });
  });

  it('publishes nothing when no actor is resolvable for any queued entry', async () => {
    const { knex, svc, publish } = await setup();
    const entity = await seedEntityRow(knex, { current_status: 'escalated' });
    await seedQueueEntry(knex, entity.id, {
      group_ref: 'group:default/does-not-exist',
      escalation_level: 1,
      position: 1,
      status: 'queued',
    });

    await svc.activateNextEntry(entity.id);

    const skipped = await knex('escalation_queue_entries')
      .where({ entity_id: entity.id })
      .first();
    expect(skipped.status).toBe('skipped');
    expect(
      publish.mock.calls.filter(
        ([e]) => e.topic === NotificationsTopic.EscalationAssigned,
      ),
    ).toHaveLength(0);
  });

  it('keeps the escalation when publishing fails', async () => {
    const { knex, svc, logger } = await setup(
      jest.fn().mockRejectedValue(new Error('bus down')),
    );
    const entity = await seedEntityRow(knex, { current_status: 'escalated' });
    await seedQueueEntry(knex, entity.id, {
      group_ref: 'group:default/portfolio-consumer',
      escalation_level: 2,
      position: 10,
      status: 'queued',
    });

    await svc.activateNextEntry(entity.id);

    const active = await knex('escalation_queue_entries')
      .where({ entity_id: entity.id, status: 'active' })
      .first();
    expect(active).toBeDefined();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('failed to publish EscalationAssigned'),
    );
  });
});
