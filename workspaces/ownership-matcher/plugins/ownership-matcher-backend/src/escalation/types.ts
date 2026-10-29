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

import { OwnershipEntity, OwnershipProposalRow } from '../types';

/** Status values for entries in the `escalation_queue_entries` table. */
export type EscalationQueueEntryStatus =
  | 'queued'
  | 'active'
  | 'completed'
  | 'cancelled'
  | 'skipped';

/** Row shape for the `escalation_queue_entries` table. */
export interface EscalationQueueEntryRow {
  id: string;
  entity_id: string;
  /** Group entity ref (e.g. */
  group_ref: string;
  /** 1-indexed level matching the configured `levels` array. */
  escalation_level: number;
  /** BFS position used for ordered selection. */
  position: number;
  status: EscalationQueueEntryStatus;
  /** User entity ref captured when the entry transitions to `active` (R5). */
  resolved_actor_ref: string | null;
  /** Populated when status moves to `cancelled` or `skipped`. */
  skip_reason: string | null;
  created_at: Date;
}

/** Categorical type of a row in the `pending_deadlines` table. */
export type DeadlineType =
  | 'proposal_expiry'
  | 'escalation_timeout'
  | 'grace_warning'
  | 'grace_expiry'
  | 'redecision_expiry'
  /** Open the catalog-info `spec.owner` PR after acceptance. Drained by PrCreationService, not the escalation handlers. */
  | 'pr_creation';

/** Row shape for the `pending_deadlines` table. */
export interface PendingDeadlineRow {
  id: string;
  entity_id: string;
  proposal_id: string | null;
  deadline_type: DeadlineType;
  fire_at: Date;
  /** Snapshot of the actor relevant to this deadline (e.g. */
  actor_ref: string | null;
  escalation_level: number | null;
  processed: boolean;
  processed_at: Date | null;
  created_at: Date;
}

/** Lightweight identifier returned by EscalationService when reporting on the next-up actor of an entity. */
export interface EscalationLevelRef {
  /** Group ref the queue entry is bound to. */
  groupRef: string;
  /** Resolved actor user ref (snapshotted at activation, never null). */
  actorRef: string;
  /** 1-indexed level matching the configured `levels` array (so `levels[level - 1]` retrieves the config). */
  level: number;
}

/** Result of `EscalationService.escalationAssign`. */
export interface AssignResult {
  entity: OwnershipEntity;
}

/** Result of `EscalationService.escalationArchive`. */
export interface ArchiveResult {
  entity: OwnershipEntity;
}

/** Result of `EscalationService.escalationReject`. */
export interface RejectResult {
  entity: OwnershipEntity;
  nextActor: EscalationLevelRef | null;
}

/** Result of `EscalationService.escalationSuggest`. */
export interface SuggestResult {
  entity: OwnershipEntity;
  proposal: OwnershipProposalRow;
}

/** Result of `EscalationService.escalationRetrigger`. */
export interface RetriggerResult {
  /** Action discriminator — fixed string `retriggered`. */
  action: 'retriggered';
  entityStatus: OwnershipEntity['current_status'];
  proposalsCreated: number;
}

/** Diff produced by `EscalationService.revalidateQueue`. */
export interface RevalidateQueueResult {
  /** Number of `queued` entries marked `cancelled` (dead group). */
  removed: number;
  /** Alias of {@link removed} kept for history payload symmetry. */
  canceledCount: number;
  /** Number of new entries inserted during the BFS rebuild. */
  addedCount: number;
  /** Number of previously-`skipped` entries whose actor now resolves and that received a fresh `queued` companion row this pass. */
  skippedRetried: number;
  /** Number of remaining `queued` entries before this revalidation pass. */
  remainingBefore: number;
  /** `true` when more than 50 % of the queued entries were dropped by pruning. */
  circuitBreakerTripped: boolean;
  /** The newly-activated entry produced by re-running the queue after the rebuild, or `null` when nothing changed / the queue was already exhausted. */
  advancedTo: EscalationLevelRef | null;
}
