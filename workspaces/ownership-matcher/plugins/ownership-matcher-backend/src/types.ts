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

// Re-exported from the node library.
export type {
  ComponentMetadata,
  CatalogComponent,
  EntityFilters,
} from '@stepstone-tech/backstage-plugin-ownership-matcher-node';
import type { ScmRepoRef } from '@stepstone-tech/backstage-plugin-ownership-matcher-node';

// ─── Contributor resolution ───────────────────────────────────────────────────

export interface ContributorInfo {
  email: string;
  teams: string[];
}

export interface ContributorCache {
  [email: string]: ContributorInfo;
}

// ─── Check types ──────────────────────────────────────────────────────────────

export type CheckName = 'orphaned' | 'zombie' | string;

// ─── Database row shapes ──────────────────────────────────────────────────────

export type ScanStatus = 'running' | 'completed' | 'failed';

export interface OwnershipScanRow {
  id: string;
  started_at: Date;
  completed_at: Date | null;
  total_entities_scanned: number;
  new_issues_found: number;
  existing_issues_updated: number;
  issues_auto_resolved: number;
  status: ScanStatus;
  error_message: string | null;
  duration_ms: number | null;
}

/** Entity case status. */
export type EntityStatus =
  | 'open'
  | 'escalated'
  | 'accepted'
  | 'to_archive'
  | 'closed'
  | 'unresolved';

export type ResolutionType = 'ownership_changed' | 'archived' | 'out_of_scope';

/**
 * State of the catalog-info `spec.owner` pull request raised after acceptance.
 * `unsupported_scm`: no installed SCM provider can raise PRs for
 * the entity's repository host — terminal until retried by hand.
 * Set by reconciliation against the catalog: `completed` — the
 * catalog's `spec.owner` is the accepted team; `declined` — the PR was
 * declined (retryable by hand); `superseded` — someone else changed the owner.
 */
export type PrStatus =
  | 'none'
  | 'pending'
  | 'raised'
  | 'failed'
  | 'unsupported_scm'
  | 'completed'
  | 'declined'
  | 'superseded';

export interface OwnershipEntityRow {
  id: string;
  entity_ref: string;
  entity_name: string;
  entity_kind: string;
  entity_namespace: string;
  current_owner: string | null;
  first_detected_at: Date;
  last_scanned_at: Date;
  current_status: EntityStatus;
  current_check: CheckName;
  check_details: string | null;
  // ── Repository identity, an `ScmRepoRef` flattened ──────────
  // Re-derived from `managed-by-location` on every processing run.
  /** Repository web URL (`ScmRepoRef.webUrl`), linked from the UI. */
  repo_url: string | null;
  /** Provider type, e.g. `bitbucketServer`, `gitlab`. */
  scm_type: string | null;
  repo_host: string | null;
  /** Provider-native path, e.g. `PROJ/repo` or `group/sub/project`. */
  repo_path: string | null;
  // ── Acceptance metadata ──────────────────────────────────────────────────
  // resolved_by: user entity ref of whoever accepted the case.
  // Source: authenticated user from POST /proposals/:id/accept
  // or POST /entities/:id/escalation/assign
  resolved_by: string | null;
  // resolved_at: set only when the case is fully closed (ownership_changed / archived).
  // Source: DatabaseOwnershipStore.closeEntity
  resolved_at: Date | null;
  // resolution_type: 'ownership_changed' for proposal/escalation acceptance; 'archived' when the
  // entity has been removed from the catalog (its repo was archived and dropped by
  // skipArchivedRepos, or it was deleted); 'out_of_scope' for all other auto-closures.
  // Source: ProposalLifecycleService.acceptProposal, escalationAssign, EntityProcessingService.closeAsOutOfScope
  resolution_type: ResolutionType | null;
  // accepted_at: timestamp set the moment the case transitions to 'accepted'.
  // Source: DatabaseOwnershipStore.acceptEntity — set to now on every acceptance
  accepted_at: Date | null;
  // assigned_to: entity ref of whoever should act next.
  // Proposal pending → proposed team; escalated → director/VP; accepted → accepted team.
  assigned_to: string | null;
  // ── Catalog-info PR tracking ────────────────────────────────
  // Source: ProposalLifecycleService.acceptProposal (enqueue) and PrCreationService (worker).
  pr_status: PrStatus;
  pr_url: string | null;
  pr_branch: string | null;
  /** Failed attempts since the last (re)enqueue. */
  pr_attempts: number;
  pr_last_error: string | null;
  /** Provider-native id of the raised PR (`ScmPullRequestRef.id`). */
  pr_id: string | null;
  /** Last reconciliation against the catalog. Source: PrReconciliationService. */
  pr_checked_at: Date | null;
  /** Optimistic-concurrency counter. */
  version: number;
}

/** Public-facing projection of an ownership entity. */
export type OwnershipEntity = Omit<OwnershipEntityRow, 'version'>;

/** The entity's repository as an {@link ScmRepoRef}, or `undefined` when unknown. */
export function entityRepo(
  row: Pick<
    OwnershipEntityRow,
    'scm_type' | 'repo_host' | 'repo_path' | 'repo_url'
  >,
): ScmRepoRef | undefined {
  if (!row.scm_type || !row.repo_host || !row.repo_path) return undefined;
  return {
    type: row.scm_type,
    host: row.repo_host,
    path: row.repo_path,
    webUrl: row.repo_url ?? '',
  };
}

/** Column values for an {@link ScmRepoRef}. */
export function repoColumns(
  repo: ScmRepoRef,
): Pick<
  OwnershipEntityRow,
  'scm_type' | 'repo_host' | 'repo_path' | 'repo_url'
> {
  return {
    scm_type: repo.type,
    repo_host: repo.host,
    repo_path: repo.path,
    repo_url: repo.webUrl,
  };
}

/** Project an internal {@link OwnershipEntityRow} to the public-facing {@link OwnershipEntity} DTO by stripping `version`. */
export function toOwnershipEntity(row: OwnershipEntityRow): OwnershipEntity {
  const { version: _version, ...dto } = row;
  return dto;
}

/** Proposal lifecycle state. */
export type ProposalStatus =
  | 'pending'
  | 'accepted'
  | 'rejected'
  | 'expired'
  | 'cancelled'
  // Low-confidence candidate (score < notificationThreshold). Stored for
  // voluntary claiming in the UI but never notified and excluded from all
  // active-lifecycle queries (pending/expiry/reminder/escalation).
  | 'possible_owner';

export interface OwnershipProposalRow {
  id: string;
  entity_id: string;
  proposed_owner_ref: string;
  proposed_owner_type: string;

  confidence_reason: string;
  confidence_score: number | null;
  proposal_order: number;
  status: ProposalStatus;
  escalation_level: number;
  notified_at: Date | null;
  responded_at: Date | null;
  response_note: string | null;
  created_at: Date;
}

/** Append-only history action types. */
export type HistoryAction =
  // ── Existing ────────────────────────────────────────────────────
  | 'issue_detected'
  | 'issue_redetected'
  | 'issue_auto_closed'
  | 'issue_closed_out_of_scope'
  | 'proposal_created'
  | 'proposal_accepted'
  | 'proposal_rejected'
  | 'proposal_expired'
  | 'entity_accepted'
  | 'entity_reopened'
  | 'entity_to_archive'
  | 'entity_closed'
  | 'status_changed'
  | 'acceptance_pending_reminder'
  | 'escalation_triggered'
  | 'no_candidates_found'
  | 'no_candidates_after_retrigger'
  | 'escalation_notified'
  | 'escalation_rejected'
  | 'escalation_suggested_created'
  | 'escalation_suggested_rejected'
  | 'escalation_exhausted'
  | 'escalation_reassigned'
  | 'escalation_auto_advanced'
  | 'escalation_retrigger'
  | 'escalation_actor_resolved'
  | 'proposal_acceptance_reverted'
  | 'escalation_queue_revalidated'
  | 'escalation_queue_entry_removed'
  | 'escalation_queue_entry_added'
  | 'escalation_queue_entry_skipped'
  // ── added for E1/E2 + Q1 fix coverage ─────────────────────
  | 'escalation_circuit_breaker_tripped'
  | 'escalation_queue_entry_retried'
  | 'escalation_grace_expired_archival'
  | 'issue_closed_archived'
  // ── Broadcast: sibling proposals cancelled on accept ──────
  | 'proposal_cancelled'
  // ── Catalog-info PR automation ──────────────────────────────
  | 'pr_creation_enqueued'
  | 'pr_raised'
  | 'pr_reused'
  | 'pr_creation_failed'
  | 'pr_creation_skipped'
  | 'pr_retry_requested'
  // ── Unresolved case self-heals when a scan finds candidates ──
  | 'reopened_candidates_found'
  // ── PR outcome reconciled against the catalog ──────────────
  | 'pr_completed'
  | 'pr_superseded'
  | 'pr_declined'
  | 'pr_not_applied';

/**
 * History actions recording why a case went `unresolved`. The latest one is
 * the case's current unresolved reason — mirrors the frontend Unresolved tab
 * (`OwnershipMatcherPage` `UNRESOLVED_REASON_ACTIONS`).
 */
export const UNRESOLVED_REASON_ACTIONS: readonly HistoryAction[] = [
  'no_candidates_found',
  'escalation_exhausted',
  'no_candidates_after_retrigger',
];

export interface OwnershipHistoryRow {
  id: string;
  entity_id: string;
  proposal_id: string | null;
  scan_id: string | null;
  action: HistoryAction;
  actor: string | null;
  details: string | null;
  created_at: Date;
}

// ─── Pagination ───────────────────────────────────────────────────────────────

export interface PaginationOptions {
  page?: number;
  limit?: number;
}

export interface PaginatedResult<T> {
  items: T[];
  total: number;
  page: number;
  limit: number;
}
