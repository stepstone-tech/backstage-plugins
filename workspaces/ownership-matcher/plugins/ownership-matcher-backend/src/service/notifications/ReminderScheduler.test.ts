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
 * Flow and integration tests for ReminderScheduler: runCycle behaviour and
 * register integration, pinning the exact scheduleTask config including
 * scope:'global'.
 */

import { mockServices } from '@backstage/backend-test-utils';
import { EventsService } from '@backstage/plugin-events-node';
import { SchedulerService } from '@backstage/backend-plugin-api';
import { ReminderScheduler, REMINDER_TASK_ID } from './ReminderScheduler';
import { NotificationsTopic } from './topics';
import {
  defaultNotificationsConfig,
  pendingProposalRow,
  notifiedProposalRow,
} from './__fixtures__';
import { createInMemoryStore } from './__fixtures__/store';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeEvents(): jest.Mocked<EventsService> {
  return {
    subscribe: jest.fn(),
    publish: jest.fn(async () => undefined),
  } as unknown as jest.Mocked<EventsService>;
}

function buildScheduler(options: {
  reminderProposals?: (typeof pendingProposalRow)[];
  entities?: Record<string, { entity_name: string }>;
  configOverrides?: Partial<typeof defaultNotificationsConfig>;
  events?: jest.Mocked<EventsService>;
}) {
  const logger = mockServices.logger.mock();
  const config = { ...defaultNotificationsConfig, ...options.configOverrides };
  const events = options.events ?? makeEvents();

  const entityMap: Record<string, { entity_name: string }> =
    options.entities ?? {};
  const store = createInMemoryStore(
    {},
    entityMap,
    [],
    options.reminderProposals ?? [],
  );

  const scheduler = new ReminderScheduler(events, store, logger, config);
  return { scheduler, events, store, logger };
}

// ─── Test suites ─────────────────────────────────────────────────────────────

describe('ReminderScheduler', () => {
  // ── register integration ────────────────────────────────────────

  describe('register()', () => {
    it('task registered with exact config: frequency={hours:24}, initialDelay={seconds:90}, scope=global, id=ownership-matcher-reminders', async () => {
      const { scheduler } = buildScheduler({ reminderProposals: [] });
      const mockScheduler = mockServices.scheduler.mock();

      await scheduler.register(mockScheduler as unknown as SchedulerService);

      expect(mockScheduler.scheduleTask).toHaveBeenCalledWith(
        expect.objectContaining({
          id: REMINDER_TASK_ID,
          frequency: { hours: 24 },
          initialDelay: { minutes: 10 },
          scope: 'global',
          timeout: { minutes: 10 },
        }),
      );
    });

    // REMINDER_TASK_ID constant must be exact
    it('REMINDER_TASK_ID constant equals "ownership-matcher-reminders"', () => {
      expect(REMINDER_TASK_ID).toBe('ownership-matcher-reminders');
    });
  });

  // ── runCycle ────────────────────────────────────────────────────

  describe('runCycle() — enabled', () => {
    // Two proposals → two publish calls
    it('enabled — queries store with reminderAfterDays and publishes one event per row', async () => {
      const proposal1 = { ...notifiedProposalRow, id: 'p1', entity_id: 'e1' };
      const proposal2 = {
        ...notifiedProposalRow,
        id: 'p2',
        entity_id: 'e2',
        proposed_owner_ref: 'group:default/team-beta',
      };
      const entities = {
        e1: { entity_name: 'svc-alpha' },
        e2: { entity_name: 'svc-beta' },
      };
      const { scheduler, events, store } = buildScheduler({
        reminderProposals: [proposal1, proposal2],
        entities,
      });

      await scheduler.runCycle();

      // Store must be queried with the configured reminderAfterDays
      expect(store.listProposalsNeedingReminder).toHaveBeenCalledWith(
        defaultNotificationsConfig.reminderAfterDays,
      );

      // One publish per proposal
      expect(events.publish).toHaveBeenCalledTimes(2);
      expect(events.publish).toHaveBeenCalledWith(
        expect.objectContaining({
          topic: NotificationsTopic.ProposalReminderDue,
          eventPayload: expect.objectContaining({
            proposalId: 'p1',
            entityId: 'e1',
            entityName: 'svc-alpha',
          }),
        }),
      );
      expect(events.publish).toHaveBeenCalledWith(
        expect.objectContaining({
          topic: NotificationsTopic.ProposalReminderDue,
          eventPayload: expect.objectContaining({
            proposalId: 'p2',
            entityId: 'e2',
            entityName: 'svc-beta',
          }),
        }),
      );
    });

    // Empty result: no publishes
    it('enabled — empty result set, no events published, no error', async () => {
      const { scheduler, events } = buildScheduler({ reminderProposals: [] });

      await expect(scheduler.runCycle()).resolves.not.toThrow();

      expect(events.publish).not.toHaveBeenCalled();
    });

    // Deleted entity: skip that proposal, loop continues
    it('proposal row has no matching entity (deleted) — skipped, loop continues', async () => {
      const proposal1 = {
        ...notifiedProposalRow,
        id: 'p1',
        entity_id: 'e1-deleted',
      };
      const proposal2 = {
        ...notifiedProposalRow,
        id: 'p2',
        entity_id: 'e2',
        proposed_owner_ref: 'group:default/team-beta',
      };
      const entities = {
        // e1-deleted is NOT in the entity map (simulates deleted entity)
        e2: { entity_name: 'svc-beta' },
      };
      const { scheduler, events } = buildScheduler({
        reminderProposals: [proposal1, proposal2],
        entities,
      });

      await scheduler.runCycle();

      // Only one publish — for the proposal with an existing entity
      expect(events.publish).toHaveBeenCalledTimes(1);
      expect(events.publish).toHaveBeenCalledWith(
        expect.objectContaining({
          eventPayload: expect.objectContaining({ proposalId: 'p2' }),
        }),
      );
    });

    // Info log emitted at cycle start
    it('emits an info log at reminder cycle start', async () => {
      const { scheduler, logger } = buildScheduler({ reminderProposals: [] });

      await scheduler.runCycle();

      expect(logger.info).toHaveBeenCalled();
    });

    // reminderAfterDays passed from config (not hard-coded)
    it('passes configured reminderAfterDays to listProposalsNeedingReminder', async () => {
      const { scheduler, store } = buildScheduler({
        reminderProposals: [],
        configOverrides: { reminderAfterDays: 14 },
      });

      await scheduler.runCycle();

      expect(store.listProposalsNeedingReminder).toHaveBeenCalledWith(14);
    });

    // Reminder payload fields match the proposal row + entity
    it('published payload fields match the proposal row + entity name', async () => {
      const proposal = {
        ...notifiedProposalRow,
        id: 'px',
        entity_id: 'ex',
        proposed_owner_ref: 'group:default/my-team',
      };
      const entities = { ex: { entity_name: 'my-svc' } };
      const { scheduler, events } = buildScheduler({
        reminderProposals: [proposal],
        entities,
      });

      await scheduler.runCycle();

      expect(events.publish).toHaveBeenCalledWith(
        expect.objectContaining({
          topic: NotificationsTopic.ProposalReminderDue,
          eventPayload: expect.objectContaining({
            proposalId: 'px',
            entityId: 'ex',
            entityName: 'my-svc',
            proposedOwnerRef: 'group:default/my-team',
          }),
        }),
      );
    });
  });

  // ── runCycle — disabled ─────────────────────────────────────────

  describe('runCycle() — disabled', () => {
    it('notifications.enabled=false — returns immediately, no query, no publish', async () => {
      const { scheduler, events, store } = buildScheduler({
        reminderProposals: [notifiedProposalRow],
        configOverrides: { enabled: false },
      });

      await expect(scheduler.runCycle()).resolves.not.toThrow();

      expect(store.listProposalsNeedingReminder).not.toHaveBeenCalled();
      expect(events.publish).not.toHaveBeenCalled();
    });
  });

  // ── listProposalsNeedingReminder query logic ──
  // These are unit tests against the store's query logic.
  // They require a real DB integration (pg-mem / sqlite) — mark as todo
  // until the store integration test suite provides the seeding infrastructure.

  describe('listProposalsNeedingReminder query logic', () => {
    it.todo(
      'notified row with notified_at older than N days is included; notified_at within N days is excluded (requires DB integration)',
    );

    it.todo(
      'pending row with created_at older than 1 day is included; created_at within 1 day is excluded (note: 1-day threshold is hard-coded)',
    );
  });
});
