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

import { createHash } from 'node:crypto';
import { LoggerService } from '@backstage/backend-plugin-api';
import { parseEntityRef } from '@backstage/catalog-model';
import { EventsService } from '@backstage/plugin-events-node';
import { OwnershipStore } from '../DatabaseOwnershipStore';
import { NotificationsConfig } from '../../config/types';
import { Notifier, NotifyPayload } from './Notifier';
import {
  AcceptancePendingEventPayload,
  ArchivePendingEventPayload,
  EscalationAssignedEventPayload,
  GraceWarningEventPayload,
  NotificationsTopic,
  ProposalExpiredEventPayload,
  ProposalReminderDueEventPayload,
  ProposalsBatchReadyEventPayload,
} from './topics';

// ─── Constants ──────────
export const SUBSCRIBER_ID = 'ownership-matcher.notifications' as const;
export const ACCEPTANCE_PENDING_HISTORY_ACTION =
  'acceptance_pending_reminder' as const;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

const MY_PROPOSALS_LINK = '/my-ownership-proposals';
const MY_ESCALATIONS_LINK = `${MY_PROPOSALS_LINK}?tab=escalations`;

/** Catalog entity page (`/catalog/:namespace/:kind/:name`); falls back to My Proposals for an unparsable ref. */
function catalogEntityLink(entityRef: string): string {
  try {
    const { kind, namespace, name } = parseEntityRef(entityRef);
    const segments = [
      namespace.toLocaleLowerCase('en-US'),
      kind.toLocaleLowerCase('en-US'),
      name,
    ].map(encodeURIComponent);
    return `/catalog/${segments.join('/')}`;
  } catch {
    return MY_PROPOSALS_LINK;
  }
}

/** Subset of OwnershipStore the notifications subscriber relies on. */
type NotificationsStoreSlice = Pick<
  OwnershipStore,
  | 'getProposal'
  | 'refreshNotifiedAt'
  | 'appendHistory'
  | 'getLatestHistoryAction'
  | 'listPendingProposalIdsForOwner'
>;

/** Subscribes to the four ownership-matcher domain events and turns them into Backstage in-app notifications via the injected `Notifier` port. */
export class OwnershipNotificationService {
  private readonly logger: LoggerService;

  constructor(
    private readonly notifier: Notifier,
    private readonly store: NotificationsStoreSlice,
    private readonly events: EventsService,
    logger: LoggerService,
    private readonly config: NotificationsConfig,
  ) {
    // A logger.child({ subscriber: SUBSCRIBER_ID }) was considered, but the
    // tests assert directly on the parent logger's spies
    // and mockServices.logger.mock.child returns a fresh, unrelated mock.
    // Keep the parent logger so test assertions remain valid; revisit if/when
    // the test harness exposes a delegating child mock.
    this.logger = logger;
  }

  /** Registers the subscriber with the events bus when notifications are enabled. */
  async init(): Promise<void> {
    if (!this.config.enabled) {
      this.logger.info('OwnershipNotificationService: disabled by config');
      return;
    }

    await this.events.subscribe({
      id: SUBSCRIBER_ID,
      topics: [
        NotificationsTopic.ProposalsBatchReady,
        NotificationsTopic.ProposalReminderDue,
        NotificationsTopic.ProposalExpired,
        NotificationsTopic.AcceptancePending,
        NotificationsTopic.GraceWarning,
        NotificationsTopic.ArchivePending,
        NotificationsTopic.EscalationAssigned,
      ],
      onEvent: params => this.onEvent(params),
    });
  }

  private async onEvent(params: {
    topic: string;
    eventPayload: unknown;
  }): Promise<void> {
    try {
      switch (params.topic) {
        case NotificationsTopic.ProposalsBatchReady:
          await this.handleProposalsBatchReady(
            params.eventPayload as ProposalsBatchReadyEventPayload,
          );
          return;
        case NotificationsTopic.ProposalReminderDue:
          await this.handleProposalReminder(
            params.eventPayload as ProposalReminderDueEventPayload,
          );
          return;
        case NotificationsTopic.ProposalExpired:
          await this.handleProposalExpired(
            params.eventPayload as ProposalExpiredEventPayload,
          );
          return;
        case NotificationsTopic.AcceptancePending:
          await this.handleAcceptancePending(
            params.eventPayload as AcceptancePendingEventPayload,
          );
          return;
        case NotificationsTopic.GraceWarning:
          await this.handleGraceWarning(
            params.eventPayload as GraceWarningEventPayload,
          );
          return;
        case NotificationsTopic.ArchivePending:
          await this.handleArchivePending(
            params.eventPayload as ArchivePendingEventPayload,
          );
          return;
        case NotificationsTopic.EscalationAssigned:
          await this.handleEscalationAssigned(
            params.eventPayload as EscalationAssignedEventPayload,
          );
          return;
        default:
          this.logger.warn(
            `OwnershipNotificationService: unhandled topic ${params.topic}`,
          );
      }
    } catch (error) {
      this.logger.warn(
        `OwnershipNotificationService: handler for ${params.topic} failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  private async handleProposalsBatchReady(
    payload: ProposalsBatchReadyEventPayload,
  ): Promise<void> {
    const pendingIds = await this.store.listPendingProposalIdsForOwner(
      payload.proposedOwnerRef,
    );
    if (pendingIds.length === 0) return;

    // Hash the full pending set so the dedup key collapses repeat sends when
    // the team's queue hasn't moved, but rolls forward as soon as it changes.
    const hash = createHash('sha1').update(pendingIds.join(',')).digest('hex');
    const dedupKey = `proposals-batch:${payload.proposedOwnerRef}:${hash}`;

    const notifyPayload: NotifyPayload = {
      title: `Your team has ${pendingIds.length} ownership proposal(s) to review`,
      description: `Latest scan surfaced ${payload.newProposalIds.length} new candidate(s). Review and accept or reject.`,
      link: MY_PROPOSALS_LINK,
      severity: 'normal',
      dedupKey,
      topic: NotificationsTopic.ProposalsBatchReady,
    };

    const result = await this.notifier.notifyTeam(
      payload.proposedOwnerRef,
      notifyPayload,
    );

    if (result.kind === 'sent') {
      const now = new Date();
      await Promise.all(
        payload.newProposalIds.map(id => this.store.refreshNotifiedAt(id, now)),
      );
      return;
    }
    if (result.kind === 'no-recipients') {
      this.logger.warn(
        `ProposalsBatchReady: no members for ${payload.proposedOwnerRef}, skipping notification`,
      );
      return;
    }
    if (result.kind === 'send-failed') {
      this.logger.warn(
        `ProposalsBatchReady: send failed for ${payload.proposedOwnerRef}: ${result.error.message}`,
      );
    }
  }

  private async handleProposalReminder(
    payload: ProposalReminderDueEventPayload,
  ): Promise<void> {
    const proposal = await this.store.getProposal(payload.proposalId);
    if (!proposal) return;
    if (proposal.status !== 'pending') return;

    const notifyPayload: NotifyPayload = {
      title: `Reminder: ownership proposal for ${payload.entityName}`,
      description: `This proposal is still pending your team's response.`,
      link: MY_PROPOSALS_LINK,
      severity: 'normal',
      dedupKey: `proposal:${payload.proposalId}`,
      topic: NotificationsTopic.ProposalReminderDue,
    };

    const result = await this.notifier.notifyTeam(
      payload.proposedOwnerRef,
      notifyPayload,
    );

    switch (result.kind) {
      case 'sent':
        await this.store.refreshNotifiedAt(payload.proposalId, new Date());
        return;
      case 'no-recipients':
        this.logger.warn(
          `Proposal reminder ${payload.proposalId}: no members for ${payload.proposedOwnerRef}, skipping`,
        );
        return;
      case 'send-failed':
        this.logger.warn(
          `Proposal reminder ${payload.proposalId}: send failed for ${payload.proposedOwnerRef}: ${result.error.message}`,
        );
        return;
      default:
        return;
    }
  }

  private async handleProposalExpired(
    payload: ProposalExpiredEventPayload,
  ): Promise<void> {
    const notifyPayload: NotifyPayload = {
      title: `Ownership proposal for ${payload.entityName} expired`,
      description: `The proposal for your team has expired without a response.`,
      link: MY_PROPOSALS_LINK,
      severity: 'low',
      dedupKey: `proposal:${payload.proposalId}`,
      topic: NotificationsTopic.ProposalExpired,
    };

    const result = await this.notifier.notifyTeam(
      payload.proposedOwnerRef,
      notifyPayload,
    );

    if (result.kind === 'send-failed') {
      this.logger.warn(
        `Proposal expired ${payload.proposalId}: send failed for ${payload.proposedOwnerRef}: ${result.error.message}`,
      );
    }
    // No-recipients: silent. Sent: no DB writes.
  }

  private async handleAcceptancePending(
    payload: AcceptancePendingEventPayload,
  ): Promise<void> {
    const last = await this.store.getLatestHistoryAction(
      payload.entityId,
      ACCEPTANCE_PENDING_HISTORY_ACTION,
    );
    if (last) {
      const elapsedDays =
        (Date.now() - new Date(last.created_at).getTime()) / MS_PER_DAY;
      if (elapsedDays < this.config.acceptancePendingReminderDays) return;
    }

    const days = Math.floor(payload.daysSinceAcceptance);
    // With an open catalog-info PR, point the team at the PR instead.
    const notifyPayload: NotifyPayload = {
      title: payload.prUrl
        ? `Review the spec.owner pull request for ${payload.entityName}`
        : `Update spec.owner for ${payload.entityName}`,
      description: payload.prUrl
        ? `You accepted ownership ${days} day(s) ago. A pull request updating spec.owner is waiting to be merged.`
        : `You accepted ownership ${days} day(s) ago but spec.owner hasn't been updated yet.`,
      link: payload.prUrl ?? payload.repoUrl ?? MY_PROPOSALS_LINK,
      severity: 'low',
      dedupKey: `entity:${payload.entityId}`,
      topic: NotificationsTopic.AcceptancePending,
    };

    const result = await this.notifier.notifyTeam(
      payload.assignedTo,
      notifyPayload,
    );

    switch (result.kind) {
      case 'sent':
        await this.store.appendHistory({
          entity_id: payload.entityId,
          action: ACCEPTANCE_PENDING_HISTORY_ACTION,
          actor: 'system',
          details: {
            recipients: result.recipients,
            daysSinceAcceptance: payload.daysSinceAcceptance,
          },
        });
        return;
      case 'no-recipients':
        this.logger.warn(
          `Acceptance-pending nag for entity ${payload.entityId}: no members for ${payload.assignedTo}, skipping`,
        );
        return;
      case 'send-failed':
        this.logger.warn(
          `Acceptance-pending nag for entity ${payload.entityId}: send failed for ${payload.assignedTo}: ${result.error.message}`,
        );
        return;
      default:
        return;
    }
  }

  private async handleGraceWarning(
    payload: GraceWarningEventPayload,
  ): Promise<void> {
    const notifyPayload: NotifyPayload = {
      title: `Grace period ending for ${payload.entityName}`,
      description: `Your team has ${Math.ceil(
        payload.daysUntilExpiry,
      )} day(s) to confirm ownership before the grace period expires on ${
        payload.expiresAt
      }.`,
      link: MY_PROPOSALS_LINK,
      severity: 'normal',
      dedupKey: `grace:${payload.entityId}:${payload.expiresAt}`,
      topic: NotificationsTopic.GraceWarning,
    };

    const result = await this.notifier.notifyTeam(
      payload.recipientRef,
      notifyPayload,
    );

    if (result.kind === 'no-recipients') {
      this.logger.warn(
        `Grace-warning ${payload.entityId}: no members for ${payload.recipientRef}, skipping`,
      );
    } else if (result.kind === 'send-failed') {
      this.logger.warn(
        `Grace-warning ${payload.entityId}: send failed for ${payload.recipientRef}: ${result.error.message}`,
      );
    }
  }

  private async handleArchivePending(
    payload: ArchivePendingEventPayload,
  ): Promise<void> {
    const notifyPayload: NotifyPayload = {
      title: `Archive required: ${payload.entityName}`,
      description: `Your team has been assigned to archive this entity. Please complete the archival action.`,
      link: catalogEntityLink(payload.entityRef),
      severity: 'normal',
      dedupKey: `archive:${payload.entityId}`,
      topic: NotificationsTopic.ArchivePending,
    };

    const result = await this.notifier.notifyTeam(
      payload.assigneeRef,
      notifyPayload,
    );

    if (result.kind === 'no-recipients') {
      this.logger.warn(
        `Archive-pending ${payload.entityId}: no members for ${payload.assigneeRef}, skipping`,
      );
    } else if (result.kind === 'send-failed') {
      this.logger.warn(
        `Archive-pending ${payload.entityId}: send failed for ${payload.assigneeRef}: ${result.error.message}`,
      );
    }
  }

  private async handleEscalationAssigned(
    payload: EscalationAssignedEventPayload,
  ): Promise<void> {
    const notifyPayload: NotifyPayload = {
      title: `Escalation: ${payload.entityName} needs an owner`,
      description: `Every proposed team rejected ownership of this entity, so it has been escalated to you (level ${payload.level}). Please assign an owner or archive it.`,
      link: MY_ESCALATIONS_LINK,
      severity: 'high',
      dedupKey: `escalation:${payload.entityId}:${payload.level}`,
      topic: NotificationsTopic.EscalationAssigned,
    };

    const result = await this.notifier.notifyUser(
      payload.actorRef,
      notifyPayload,
    );

    if (result.kind === 'send-failed') {
      this.logger.warn(
        `Escalation-assigned ${payload.entityId}: send failed for ${payload.actorRef}: ${result.error.message}`,
      );
    }
  }
}

export type { NotifyResult } from './Notifier';
