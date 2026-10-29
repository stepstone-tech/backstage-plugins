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

import { LoggerService, SchedulerService } from '@backstage/backend-plugin-api';
import { EventsService } from '@backstage/plugin-events-node';
import { OwnershipStore } from '../DatabaseOwnershipStore';
import { NotificationsConfig } from '../../config/types';
import { NotificationsTopic, ProposalReminderDueEventPayload } from './topics';

export const REMINDER_TASK_ID = 'ownership-matcher-reminders' as const;

/** Subset of OwnershipStore the reminder scheduler relies on. */
type ReminderStoreSlice = Pick<
  OwnershipStore,
  'listProposalsNeedingReminder' | 'getEntityById'
>;

/** Producer of `ownership-matcher.proposal.reminder-due`. */
export class ReminderScheduler {
  constructor(
    private readonly events: EventsService,
    private readonly store: ReminderStoreSlice,
    private readonly logger: LoggerService,
    private readonly config: NotificationsConfig,
  ) {}

  /** Idempotent cycle: queries `listProposalsNeedingReminder` and publishes one `proposal.reminder-due` per returned row. */
  async runCycle(): Promise<void> {
    if (!this.config.enabled) return;

    this.logger.info('Ownership reminder cycle: starting...');

    const proposals = await this.store.listProposalsNeedingReminder(
      this.config.reminderAfterDays,
    );

    for (const proposal of proposals) {
      const entity = await this.store.getEntityById(proposal.entity_id);
      if (!entity) continue;

      await this.events.publish({
        topic: NotificationsTopic.ProposalReminderDue,
        eventPayload: {
          proposalId: proposal.id,
          entityId: proposal.entity_id,
          entityName: entity.entity_name,
          proposedOwnerRef: proposal.proposed_owner_ref,
        } satisfies ProposalReminderDueEventPayload,
      });
    }
  }

  /** Registers the cycle with the Backstage scheduler. */
  async register(scheduler: SchedulerService): Promise<void> {
    await scheduler.scheduleTask({
      id: REMINDER_TASK_ID,
      frequency: { hours: 24 },
      timeout: { minutes: 10 },
      initialDelay: { minutes: 10 },
      scope: 'global',
      fn: () => this.runCycle(),
    });
  }
}
