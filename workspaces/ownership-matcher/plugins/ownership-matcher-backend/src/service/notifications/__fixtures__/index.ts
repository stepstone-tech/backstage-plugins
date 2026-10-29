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
 * Canonical test fixtures shared across notification flow tests.
 * Imported by Notifier.test.ts, OwnershipNotificationService.test.ts,
 * and ReminderScheduler.test.ts.
 */

import { NotificationsConfig } from '../../../config/types';
import { OwnershipHistoryRow, OwnershipProposalRow } from '../../../types';

// ─── Entity fixtures ──────────────────────────────────────────────────────────

/**
 * Group entity with hasMember relations (resolution priority 1).
 */
export const groupEntityWithRelations = {
  kind: 'Group',
  metadata: { name: 'team-alpha', namespace: 'default' },
  spec: {},
  relations: [
    { type: 'hasMember', targetRef: 'user:default/alice' },
    { type: 'hasMember', targetRef: 'user:default/bob' },
  ],
};

/**
 * Group entity with spec.members only (relations absent).
 */
export const groupEntityWithSpecMembers = {
  kind: 'Group',
  metadata: { name: 'team-alpha', namespace: 'default' },
  spec: {
    members: ['carol', 'user:default/dave'],
  },
  relations: [],
};

// ─── Proposal row fixtures ────────────────────────────────────────────────────

const NOW = new Date();
const TWO_DAYS_AGO = new Date(NOW.getTime() - 2 * 24 * 60 * 60 * 1000);
const EIGHT_DAYS_AGO = new Date(NOW.getTime() - 8 * 24 * 60 * 60 * 1000);

/**
 * Proposal in initial pending state (not yet notified).
 */
export const pendingProposalRow: OwnershipProposalRow = {
  id: 'p1',
  entity_id: 'e1',
  proposed_owner_ref: 'group:default/team-alpha',
  proposed_owner_type: 'team',
  status: 'pending',
  confidence_reason: JSON.stringify([
    'low confidence score',
    'no current owner',
  ]),
  confidence_score: 0.7,
  proposal_order: 1,
  escalation_level: 0,
  notified_at: null,
  responded_at: null,
  response_note: null,
  created_at: TWO_DAYS_AGO,
};

/**
 * Pending proposal whose `notified_at` is stale (8 days ago). Used by the
 * reminder flow — after the escalation migration `pending` is the single
 * "active and notified" status, so a reminder-eligible proposal is one that
 * is `pending` AND `notified_at < now - reminderAfterDays`.
 */
export const notifiedProposalRow: OwnershipProposalRow = {
  ...pendingProposalRow,
  status: 'pending',
  notified_at: EIGHT_DAYS_AGO,
};

/**
 * Proposal that has expired.
 */
export const expiredProposalRow: OwnershipProposalRow = {
  id: 'p2',
  entity_id: 'e2',
  proposed_owner_ref: 'group:default/team-beta',
  proposed_owner_type: 'team',
  status: 'expired',
  confidence_reason: JSON.stringify([]),
  confidence_score: 0.5,
  proposal_order: 1,
  escalation_level: 0,
  notified_at: EIGHT_DAYS_AGO,
  responded_at: null,
  response_note: null,
  created_at: TWO_DAYS_AGO,
};

// ─── Event payload fixtures ───────────────────────────────────────────────────

/**
 * Raw acceptance.pending event payload.
 */
export const acceptancePendingEventPayload = {
  entityId: 'e3',
  entityName: 'svc-gamma',
  assignedTo: 'group:default/team-gamma',
  daysSinceAcceptance: 5.3,
  repoUrl: null,
};

// ─── Config fixtures ──────────────────────────────────────────────────────────

/**
 * Default notifications config (matches NOTIFICATIONS_DEFAULTS from reader.ts).
 * Used as the expected default and as the config baseline for flow tests.
 */
export const defaultNotificationsConfig: NotificationsConfig = {
  enabled: true,
  channels: ['backstage'],
  remindersEnabled: false,
  reminderAfterDays: 7,
  acceptancePendingReminderDays: 7,
};

// ─── Throttle history row fixtures ───────────────────────────────────────────

const THREE_DAYS_AGO = new Date(NOW.getTime() - 3 * 24 * 60 * 60 * 1000);
const TEN_DAYS_AGO = new Date(NOW.getTime() - 10 * 24 * 60 * 60 * 1000);

/**
 * History row within the 7-day throttle window (3 days old).
 */
export const recentThrottleHistoryRow: OwnershipHistoryRow = {
  id: 'h1',
  entity_id: 'e3',
  proposal_id: null,
  scan_id: null,
  action: 'acceptance_pending_reminder',
  actor: 'system',
  details: null,
  created_at: THREE_DAYS_AGO,
};

/**
 * History row outside the 7-day throttle window (10 days old).
 */
export const staleThrottleHistoryRow: OwnershipHistoryRow = {
  id: 'h2',
  entity_id: 'e3',
  proposal_id: null,
  scan_id: null,
  action: 'acceptance_pending_reminder',
  actor: 'system',
  details: null,
  created_at: TEN_DAYS_AGO,
};
