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

import { Knex } from 'knex';
import {
  EntityStatus,
  PrStatus,
  ProposalStatus,
  ResolutionType,
} from '../../types';

// Use Node.js built-in to avoid uuid devDependency constraint (@backstage/no-undeclared-imports).
const uuid = () => crypto.randomUUID();

/**
 * Shared DB-level seed helpers.
 *
 * Used by test files that test against a real database (DatabaseOwnershipStore
 * integration tests, DeadlineChecker.test.ts, Concurrency.test.ts, etc.).
 *
 * Why a separate file: these helpers avoid 10+ lines of boilerplate per test
 * that would otherwise be duplicated across 6+ test files. All parameters are
 * optional with sensible defaults.
 */

export interface SeededEntity {
  id: string;
  entity_ref: string;
  current_status: EntityStatus;
  version: number;
}

export interface SeededProposal {
  id: string;
  entity_id: string;
  proposed_owner_ref: string;
  status: ProposalStatus;
  proposal_order: number;
  escalation_level: number;
}

export interface SeededDeadline {
  id: string;
  entity_id: string;
  deadline_type: string;
  fire_at: Date;
  processed: boolean;
}

export interface SeededQueueEntry {
  id: string;
  entity_id: string;
  group_ref: string;
  escalation_level: number;
  position: number;
  status: string;
  resolved_actor_ref: string | null;
}

/**
 * Insert a minimal ownership entity row. Returns the row so tests can
 * reference its `id` and `version`.
 */
export async function seedEntityRow(
  db: Knex,
  overrides: Partial<{
    id: string;
    entity_ref: string;
    entity_name: string;
    entity_kind: string;
    entity_namespace: string;
    current_status: EntityStatus;
    version: number;
    assigned_to: string;
    resolved_by: string;
    pr_status: PrStatus;
    pr_branch: string;
    pr_attempts: number;
    pr_url: string;
    pr_id: string;
    pr_checked_at: Date;
    current_owner: string;
    check_details: Record<string, unknown>;
    resolution_type: ResolutionType;
    accepted_at: Date;
    resolved_at: Date;
    scm_type: string;
    repo_host: string;
    repo_path: string;
  }> = {},
): Promise<SeededEntity> {
  const id = overrides.id ?? uuid();
  const ref = overrides.entity_ref ?? `component:default/svc-${id.slice(0, 8)}`;
  const row = {
    id,
    entity_ref: ref,
    entity_name: overrides.entity_name ?? ref.split('/')[1],
    entity_kind: overrides.entity_kind ?? 'Component',
    entity_namespace: overrides.entity_namespace ?? 'default',
    current_owner: overrides.current_owner ?? null,
    first_detected_at: new Date(),
    last_scanned_at: new Date(),
    current_status: overrides.current_status ?? 'open',
    current_check: 'orphaned',
    check_details: overrides.check_details
      ? JSON.stringify(overrides.check_details)
      : null,
    repo_url: null,
    scm_type: overrides.scm_type ?? null,
    repo_host: overrides.repo_host ?? null,
    repo_path: overrides.repo_path ?? null,
    resolved_by: overrides.resolved_by ?? null,
    resolved_at: overrides.resolved_at ?? null,
    resolution_type: overrides.resolution_type ?? null,
    accepted_at: overrides.accepted_at ?? null,
    assigned_to: overrides.assigned_to ?? null,
    pr_status: overrides.pr_status ?? 'none',
    pr_branch: overrides.pr_branch ?? null,
    pr_attempts: overrides.pr_attempts ?? 0,
    pr_url: overrides.pr_url ?? null,
    pr_id: overrides.pr_id ?? null,
    pr_checked_at: overrides.pr_checked_at ?? null,
    version: overrides.version ?? 1,
  };
  await db('ownership_entities').insert(row);
  return {
    id,
    entity_ref: ref,
    current_status: row.current_status,
    version: row.version,
  };
}

/**
 * Insert a proposal row. Returns the row for reference.
 */
export async function seedProposalRow(
  db: Knex,
  entityId: string,
  overrides: Partial<{
    id: string;
    proposed_owner_ref: string;
    status: ProposalStatus;
    proposal_order: number;
    escalation_level: number;
    confidence_score: number;
  }> = {},
): Promise<SeededProposal> {
  const id = overrides.id ?? uuid();
  const ownerRef =
    overrides.proposed_owner_ref ?? `group:default/team-${id.slice(0, 4)}`;
  const row = {
    id,
    entity_id: entityId,
    proposed_owner_ref: ownerRef,
    proposed_owner_type: 'team',
    confidence_reason: 'top_contributor',
    confidence_score: overrides.confidence_score ?? 0.8,
    proposal_order: overrides.proposal_order ?? 1,
    status: overrides.status ?? 'pending',
    escalation_level: overrides.escalation_level ?? 0,
    notified_at: new Date(),
    responded_at: null,
    response_note: null,
    created_at: new Date(),
  };
  await db('ownership_proposals').insert(row);
  return {
    id,
    entity_id: entityId,
    proposed_owner_ref: ownerRef,
    status: row.status,
    proposal_order: row.proposal_order,
    escalation_level: row.escalation_level,
  };
}

/**
 * Insert a pending_deadlines row.
 */
export async function seedDeadlineRow(
  db: Knex,
  entityId: string,
  overrides: Partial<{
    id: string;
    proposal_id: string | null;
    deadline_type: string;
    fire_at: Date;
    actor_ref: string | null;
    escalation_level: number | null;
    processed: boolean;
  }> = {},
): Promise<SeededDeadline> {
  const id = overrides.id ?? uuid();
  const fireAt = overrides.fire_at ?? new Date(Date.now() - 1000); // past by default
  const row = {
    id,
    entity_id: entityId,
    proposal_id: overrides.proposal_id ?? null,
    deadline_type: overrides.deadline_type ?? 'escalation_timeout',
    fire_at: fireAt,
    actor_ref: overrides.actor_ref ?? null,
    escalation_level: overrides.escalation_level ?? null,
    processed: overrides.processed ?? false,
    processed_at: null,
    created_at: new Date(),
  };
  await db('pending_deadlines').insert(row);
  return {
    id,
    entity_id: entityId,
    deadline_type: row.deadline_type,
    fire_at: fireAt,
    processed: row.processed,
  };
}

/**
 * Insert an escalation_queue_entries row.
 */
export async function seedQueueEntry(
  db: Knex,
  entityId: string,
  overrides: Partial<{
    id: string;
    group_ref: string;
    escalation_level: number;
    position: number;
    status: string;
    resolved_actor_ref: string | null;
    skip_reason: string | null;
  }> = {},
): Promise<SeededQueueEntry> {
  const id = overrides.id ?? uuid();
  const row = {
    id,
    entity_id: entityId,
    group_ref: overrides.group_ref ?? 'group:default/domain-search',
    escalation_level: overrides.escalation_level ?? 1,
    position: overrides.position ?? 1,
    status: overrides.status ?? 'queued',
    resolved_actor_ref: overrides.resolved_actor_ref ?? null,
    skip_reason: overrides.skip_reason ?? null,
    created_at: new Date(),
  };
  await db('escalation_queue_entries').insert(row);
  return {
    id,
    entity_id: entityId,
    group_ref: row.group_ref,
    escalation_level: row.escalation_level,
    position: row.position,
    status: row.status,
    resolved_actor_ref: row.resolved_actor_ref,
  };
}
