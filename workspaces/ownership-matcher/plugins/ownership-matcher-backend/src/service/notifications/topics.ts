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

/** Single source of truth for ownership-matcher notification topic names. */
export const NotificationsTopic = {
  ProposalsBatchReady: 'ownership-matcher.proposals.batch-ready',
  ProposalReminderDue: 'ownership-matcher.proposal.reminder-due',
  ProposalExpired: 'ownership-matcher.proposal.expired',
  AcceptancePending: 'ownership-matcher.acceptance.pending',
  GraceWarning: 'ownership-matcher.grace.warning',
  ArchivePending: 'ownership-matcher.archive.pending',
  EscalationAssigned: 'ownership-matcher.escalation.assigned',
} as const;

export type NotificationsTopicValue =
  (typeof NotificationsTopic)[keyof typeof NotificationsTopic];

/**
 * One event per team per scan, fired after the scan finishes persisting
 * proposals. The handler reads the team's full pending set and sends a single
 * digest notification (replaces the per-proposal `ProposalCreated` event).
 */
export interface ProposalsBatchReadyEventPayload {
  /** Group entityRef the digest is addressed to. */
  proposedOwnerRef: string;
  /** IDs of proposals added in this scan (for `notified_at` bookkeeping). */
  newProposalIds: string[];
  /** Originating scan id, for traceability. */
  scanId: string;
}

/** Published when a pending proposal is due for a reminder. */
export interface ProposalReminderDueEventPayload {
  proposalId: string;
  entityId: string;
  entityName: string;
  proposedOwnerRef: string;
}

/** Published when a proposal expires. */
export interface ProposalExpiredEventPayload {
  proposalId: string;
  entityId: string;
  entityName: string;
  proposedOwnerRef: string;
}

/** Published when an accepted entity is re-detected while still pending in the catalog. */
export interface AcceptancePendingEventPayload {
  entityId: string;
  entityName: string;
  assignedTo: string;
  daysSinceAcceptance: number;
  repoUrl: string | null;
  /** The open catalog-info PR (`pr_status = 'raised'`), if any. */
  prUrl?: string | null;
}

/** Fired immediately when an entity is marked to_archive so the assignee team is notified. */
export interface ArchivePendingEventPayload {
  entityId: string;
  entityName: string;
  /** Catalog entity ref (e.g. `component:default/foo`); the notification links to its catalog page. */
  entityRef: string;
  /** Team ref that should archive the entity (set from `assigneeRef` in the archive request). */
  assigneeRef: string;
}

/** Pre-expiry warning fired by the deadline checker N days before a grace deadline. */
export interface GraceWarningEventPayload {
  entityId: string;
  entityName: string;
  /** Team ref that should be notified (set from `actor_ref` on the deadline row). */
  recipientRef: string;
  /** ISO timestamp when the grace period expires. */
  expiresAt: string;
  daysUntilExpiry: number;
}

/**
 * Fired when an escalation queue entry is activated for a resolved actor, so
 * that person (a user, not a team) is told a case now awaits their decision.
 */
export interface EscalationAssignedEventPayload {
  entityId: string;
  entityName: string;
  entityRef: string;
  /** User ref the escalation was routed to (`resolved_actor_ref`). */
  actorRef: string;
  /** Group whose queue entry was activated. */
  groupRef: string;
  /** 1-indexed escalation level. */
  level: number;
}

/** Discriminated union of every notification event the subscriber handles. */
export type NotificationsEvent =
  | {
      topic: typeof NotificationsTopic.ProposalsBatchReady;
      eventPayload: ProposalsBatchReadyEventPayload;
    }
  | {
      topic: typeof NotificationsTopic.ProposalReminderDue;
      eventPayload: ProposalReminderDueEventPayload;
    }
  | {
      topic: typeof NotificationsTopic.ProposalExpired;
      eventPayload: ProposalExpiredEventPayload;
    }
  | {
      topic: typeof NotificationsTopic.AcceptancePending;
      eventPayload: AcceptancePendingEventPayload;
    }
  | {
      topic: typeof NotificationsTopic.GraceWarning;
      eventPayload: GraceWarningEventPayload;
    }
  | {
      topic: typeof NotificationsTopic.ArchivePending;
      eventPayload: ArchivePendingEventPayload;
    }
  | {
      topic: typeof NotificationsTopic.EscalationAssigned;
      eventPayload: EscalationAssignedEventPayload;
    };
