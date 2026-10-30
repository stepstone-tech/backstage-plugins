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

export interface OwnershipEntity {
  id: string;
  entity_ref: string;
  entity_name: string;
  entity_kind: string;
  entity_namespace: string;
  current_owner: string | null;
  first_detected_at: string;
  last_scanned_at: string;
  current_status: string;
  current_check: string;
  check_details: string | null;
  repo_url: string | null;
  resolved_at: string | null;
  resolved_by: string | null;
  resolution_type: string | null;
  assigned_to: string | null;
  /** State of the catalog-info `spec.owner` PR raised after acceptance. */
  pr_status?: PrStatus;
  pr_url?: string | null;
  pr_branch?: string | null;
  pr_attempts?: number;
  pr_last_error?: string | null;
}

export type PrStatus =
  | 'none'
  | 'pending'
  | 'raised'
  | 'failed'
  | 'unsupported_scm'
  /** The catalog's spec.owner is the accepted team. */
  | 'completed'
  /** The PR was declined; it can be raised again. */
  | 'declined'
  /** Someone else changed the owner; no further PRs are raised. */
  | 'superseded';

export interface OwnershipProposal {
  id: string;
  entity_id: string;
  proposed_owner_ref: string;
  proposed_owner_type: string;
  confidence_reason: string;
  confidence_score: number | null;
  proposal_order: number;
  status: string;
  escalation_level: number;
  notified_at: string | null;
  responded_at: string | null;
  response_note: string | null;
  created_at: string;
}

export interface OwnershipHistory {
  id: string;
  entity_id: string;
  proposal_id: string | null;
  scan_id: string | null;
  action: string;
  actor: string | null;
  details: string | null;
  created_at: string;
}

export interface OwnershipScan {
  id: string;
  started_at: string;
  completed_at: string | null;
  total_entities_scanned: number;
  new_issues_found: number;
  existing_issues_updated: number;
  issues_auto_resolved: number;
  status: string;
  error_message: string | null;
  duration_ms: number | null;
}

export interface EntitiesListResponse {
  items: OwnershipEntity[];
  total: number;
  page: number;
  limit: number;
}

export interface EntityDetailResponse {
  entity: OwnershipEntity;
  proposals: OwnershipProposal[];
  history: OwnershipHistory[];
}

export interface ScansListResponse {
  scans: OwnershipScan[];
}

// ─── Definitions (signal + check descriptions served from backend) ────────────

export interface SignalDefinition {
  key: string;
  title: string;
  description: string;
}

export interface CheckDefinition {
  key: string;
  title: string;
  description: string;
}

export interface DefinitionsResponse {
  signals: SignalDefinition[];
  checks: CheckDefinition[];
}

// ─── Team-scoped proposal types (used by the user-facing page) ───────────────

/** A single item returned by GET /proposals/for-team. */
export interface TeamProposalItem {
  proposal: OwnershipProposal;
  entity: OwnershipEntity;
  /** User entity ref of the team member who accepted/rejected, if known. */
  actor: string | null;
}

export interface TeamProposalsResponse {
  items: TeamProposalItem[];
}

export interface ConfidenceBucket {
  label: string;
  min: number;
  max: number;
  count: number;
}

export interface DashboardStats {
  totalOpen: number;
  perCheck: Record<string, number>;
  pendingProposals: number;
  totalProposals: number;
  avgConfidence: number | null;
  confidenceDistribution?: ConfidenceBucket[];
}

export interface AdminProposalItem {
  proposal: OwnershipProposal;
  entity: OwnershipEntity;
  actor: string | null;
}

export interface AdminProposalsResponse {
  items: AdminProposalItem[];
  total: number;
  page: number;
  limit: number;
}

export interface ProposalActionResponse {
  status: string;
  proposal: OwnershipProposal;
  entity: OwnershipEntity;
}

/**
 * Response from `GET /proposals/mine/summary`.
 *
 * `hash` is a stable, short content hash of the underlying pending proposal
 * id set, used by the homepage banner to keep dismissals sticky until the
 * actual list of pending proposals changes. Empty string when `pendingCount`
 * is `0`.
 */
export interface MyPendingProposalsSummary {
  pendingCount: number;
  link: string;
  hash: string;
}

// ─── Leadership-scoped types ──────────────────────────────────────────────────

export interface LeadershipStats {
  isLeader: boolean;
  totalOpen: number;
  perCheck: Record<string, number>;
  pendingProposals: number;
  totalProposals: number;
  avgConfidence: number | null;
}

export interface LeadershipProposalItem {
  proposal: OwnershipProposal;
  entity: OwnershipEntity;
  actor: string | null;
}

export interface LeadershipProposalsResponse {
  items: LeadershipProposalItem[];
  total: number;
  page: number;
  limit: number;
}
