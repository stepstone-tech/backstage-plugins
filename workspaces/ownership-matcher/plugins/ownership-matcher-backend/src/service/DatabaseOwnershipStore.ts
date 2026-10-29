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

import {
  DatabaseService,
  resolvePackagePath,
} from '@backstage/backend-plugin-api';
import { Knex } from 'knex';
import type { ScmRepoRef } from '@stepstone-tech/backstage-plugin-ownership-matcher-node';
import {
  OwnershipScanRow,
  OwnershipEntityRow,
  OwnershipProposalRow,
  OwnershipHistoryRow,
  EntityStatus,
  HistoryAction,
  PrStatus,
  ProposalStatus,
  PaginationOptions,
  PaginatedResult,
  ResolutionType,
} from '../types';
import { ScanStore } from './stores/ScanStore';
import { EntityStore } from './stores/EntityStore';
import { ProposalStore } from './stores/ProposalStore';
import { HistoryStore } from './stores/HistoryStore';
import {
  DefaultEscalationQueueStore,
  EscalationQueueStore,
} from './stores/EscalationQueueStore';
import {
  DeadlineTypeFilter,
  DefaultPendingDeadlineStore,
  PendingDeadlineStore,
} from './stores/PendingDeadlineStore';
import {
  EscalationQueueEntryRow,
  PendingDeadlineRow,
} from '../escalation/types';

const migrationsDir = resolvePackagePath(
  '@stepstone-tech/backstage-plugin-ownership-matcher-backend',
  'migrations',
);

// ─── Store interfaces ─────────────────────────────────────────────────────────

export interface CreateScanInput {
  started_at?: Date;
}

export interface CompleteScanInput {
  completed_at: Date;
  total_entities_scanned: number;
  new_issues_found: number;
  existing_issues_updated: number;
  issues_auto_resolved: number;
  status: 'completed' | 'failed';
  error_message?: string;
  duration_ms: number;
}

export interface CreateEntityInput {
  entity_ref: string;
  entity_name: string;
  entity_kind: string;
  entity_namespace: string;
  current_owner?: string;
  current_check: string;
  check_details?: Record<string, unknown>;
  /** The entity's repository, when an SCM provider resolved it. */
  repo?: ScmRepoRef;
}

export interface EntityFilter {
  status?: EntityStatus | EntityStatus[];
  kind?: string;
  namespace?: string;
  check?: string;
  assignedTo?: string;
  /** Filter to entities whose current_owner is in this set. */
  owners?: string[];
  /**
   * When set, `escalated` entities are scoped by the escalation queue instead
   * of `owners`: only those whose active `escalation_queue_entries` row has
   * `resolved_actor_ref` equal to this user ref. Non-escalated entities keep
   * the `owners` filter.
   */
  escalationActorRef?: string;
}

export interface CreateProposalInput {
  entity_id: string;
  proposed_owner_ref: string;
  /** 'Group' or 'User' — derived from the proposed_owner_ref prefix. */
  proposed_owner_type?: string;
  confidence_reason: string;
  confidence_score?: number;
  proposal_order: number;
  escalation_level?: number;
  /**
   * Initial status. Defaults to `pending`. Pass `possible_owner` for
   * low-confidence candidates that should be stored but never notified.
   */
  status?: ProposalStatus;
}

export interface AppendHistoryInput {
  entity_id: string;
  proposal_id?: string;
  scan_id?: string;
  action: HistoryAction;
  actor?: string;
  details?: Record<string, unknown>;
}

export interface ScanFilter {
  status?: 'running' | 'completed' | 'failed';
  since?: Date;
  until?: Date;
}

/** Bundle of transaction-scoped stores returned by {@link OwnershipStore.withTransaction}. */
export interface TxStores {
  scanStore: ScanStore;
  entityStore: EntityStore;
  proposalStore: ProposalStore;
  historyStore: HistoryStore;
  escalationQueueStore: EscalationQueueStore;
  pendingDeadlineStore: PendingDeadlineStore;
}

export interface OwnershipStore {
  // Stats
  getDashboardStats(): Promise<{
    totalOpen: number;
    perCheck: Record<string, number>;
    pendingProposals: number;
    avgConfidence: number | null;
    totalProposals: number;
    confidenceDistribution: Array<{
      label: string;
      min: number;
      max: number;
      count: number;
    }>;
  }>;

  /**
   * Scoped stats (totalOpen, perCheck) for a specific set of owner group refs.
   * With `escalationActorRef`, escalated entities are scoped as in {@link EntityFilter.escalationActorRef}.
   */
  getStatsForOwners(
    owners: string[],
    escalationActorRef?: string,
  ): Promise<{
    totalOpen: number;
    perCheck: Record<string, number>;
  }>;
  /** Number of `active` escalation queue entries whose resolved actor is `actorRef`. */
  countActiveEscalationsForActor(actorRef: string): Promise<number>;

  // Scans
  createScan(input?: CreateScanInput): Promise<string>;
  completeScan(id: string, input: CompleteScanInput): Promise<void>;
  failScan(id: string, errorMessage: string, durationMs: number): Promise<void>;
  failStaleScans(): Promise<number>;
  getScan(id: string): Promise<OwnershipScanRow | undefined>;
  listScans(limit?: number, filter?: ScanFilter): Promise<OwnershipScanRow[]>;

  // Entities
  createEntity(input: CreateEntityInput): Promise<string>;
  /** Bump `last_scanned_at`; with `repo`, also update the repository identity (e.g. after a Bitbucket → GitLab move). */
  updateEntityLastScanned(
    id: string,
    scanId: string,
    repo?: ScmRepoRef,
  ): Promise<void>;
  /** Transition an entity to `accepted`. */
  acceptEntity(
    id: string,
    acceptedBy: string,
    resolutionType: ResolutionType,
    expectedVersion: number,
  ): Promise<void>;
  /** @see {@link acceptEntity} for the `expectedVersion` contract. */
  reopenEntity(id: string, expectedVersion: number): Promise<void>;
  updateAssignee(id: string, assignedTo: string | null): Promise<void>;
  /** @see {@link acceptEntity} for the `expectedVersion` contract. */
  markEntityToArchive(
    id: string,
    markedBy: string,
    assigneeRef: string,
    expectedVersion: number,
  ): Promise<void>;
  closeEntity(
    id: string,
    closedBy: string,
    resolutionType: ResolutionType,
    expectedVersion: number,
  ): Promise<void>;
  setEntityEscalated(id: string, expectedVersion: number): Promise<void>;
  /** Transition an entity to `unresolved`. */
  setEntityUnresolved(id: string, expectedVersion: number): Promise<void>;
  getActiveEntityByRef(
    entityRef: string,
  ): Promise<OwnershipEntityRow | undefined>;
  getEntityById(id: string): Promise<OwnershipEntityRow | undefined>;
  /** All entities still in an actionable status — see {@link EntityStore.listActiveEntitiesForReconciliation}. */
  listActiveEntitiesForReconciliation(): Promise<OwnershipEntityRow[]>;
  /** Cases whose catalog-info PR outcome still needs reconciling — see {@link EntityStore.listEntitiesForPrReconciliation}. */
  listEntitiesForPrReconciliation(
    checkedBefore: Date,
  ): Promise<OwnershipEntityRow[]>;
  /** `pr_status` counts over every case that reached acceptance. */
  countPrStatusesForAccepted(): Promise<Partial<Record<PrStatus, number>>>;
  listEntities(
    filter?: EntityFilter,
    pagination?: PaginationOptions,
  ): Promise<PaginatedResult<OwnershipEntityRow>>;

  // Proposals
  createProposal(input: CreateProposalInput): Promise<string>;
  getProposal(id: string): Promise<OwnershipProposalRow | undefined>;
  listProposalsByEntity(entityId: string): Promise<OwnershipProposalRow[]>;
  listActiveProposalsByEntity(
    entityId: string,
  ): Promise<OwnershipProposalRow[]>;
  /** Proposals still live (pending/accepted/possible_owner) that must be terminated when a case closes. */
  listCancellableProposalsByEntity(
    entityId: string,
  ): Promise<OwnershipProposalRow[]>;
  /** Hard-deletes all `possible_owner` rows for an entity; returns the count removed. */
  deletePossibleOwnersByEntity(entityId: string): Promise<number>;
  updateProposalStatus(
    id: string,
    status: ProposalStatus,
    extra?: {
      respondedAt?: Date | null;
      responseNote?: string | null;
      notifiedAt?: Date;
    },
  ): Promise<void>;
  refreshNotifiedAt(id: string, notifiedAt: Date): Promise<void>;
  listProposalsNeedingReminder(
    reminderAfterDays: number,
  ): Promise<OwnershipProposalRow[]>;
  listProposalsForOwners(
    ownerRefs: string[],
    statuses?: ProposalStatus[],
  ): Promise<OwnershipProposalRow[]>;
  /** Returns ids of `pending` proposals addressed to the given owner ref, sorted ascending. */
  listPendingProposalIdsForOwner(ownerRef: string): Promise<string[]>;
  listAllProposals(
    pagination?: PaginationOptions,
    filter?: { status?: ProposalStatus[]; search?: string },
  ): Promise<PaginatedResult<OwnershipProposalRow>>;

  // History
  appendHistory(input: AppendHistoryInput): Promise<void>;
  listHistory(entityId: string): Promise<OwnershipHistoryRow[]>;
  getLatestHistoryAction(
    entityId: string,
    action: HistoryAction,
  ): Promise<OwnershipHistoryRow | undefined>;
  getLatestHistoryActionIn(
    entityId: string,
    actions: readonly HistoryAction[],
  ): Promise<OwnershipHistoryRow | undefined>;
  getRejectedActors(entityId: string): Promise<Set<string>>;

  /** Returns the currently-`active` queue entry for an entity, if any. */
  findActiveQueueEntry(
    entityId: string,
  ): Promise<EscalationQueueEntryRow | null>;

  /** Returns deadlines whose `fire_at <= now` and that have not been processed. */
  findExpiredDeadlines(
    now: Date,
    filter?: DeadlineTypeFilter,
  ): Promise<PendingDeadlineRow[]>;

  /** Run `fn` inside a Knex transaction, exposing transaction-scoped sub-stores. */
  withTransaction<T>(fn: (stores: TxStores) => Promise<T>): Promise<T>;

  // ── Ownership email digest ─────────────────────────────────────────────────

  /**
   * Returns one row per `pending` proposal addressed to a team on a non-closed
   * entity, for the email digest. Same predicate as `listProposalsForOwners(refs, ['pending'])`
   * so the digest count matches `/my-ownership-proposals`.
   */
  listPendingProposalsForEmail(): Promise<
    { team_ref: string; current_check: string; entity_kind: string }[]
  >;
  /** Returns true if the team already received an email for the given period key. */
  hasEmailBeenSentThisPeriod(
    teamRef: string,
    periodKey: string,
  ): Promise<boolean>;
  /** Records that an email was sent to the team for the given period key. */
  recordEmailSent(teamRef: string, periodKey: string): Promise<void>;
}

// ─── Implementation ───────────────────────────────────────────────────────────

/** Composes domain-specific stores (ScanStore, EntityStore, ProposalStore, HistoryStore) behind the unified OwnershipStore interface. */
export class DatabaseOwnershipStore implements OwnershipStore {
  /** Root Knex instance used by {@link withTransaction}. */
  private readonly db: Knex;
  private readonly scans: ScanStore;
  private readonly entities: EntityStore;
  private readonly proposals: ProposalStore;
  private readonly history: HistoryStore;
  /** Non-transactional escalation queue store used by read-only paths. */
  private readonly escalationQueue: EscalationQueueStore;
  /** Non-transactional pending-deadlines store used by the deadline checker. */
  private readonly pendingDeadlines: PendingDeadlineStore;

  private constructor(db: Knex) {
    this.db = db;
    this.scans = new ScanStore(db);
    this.entities = new EntityStore(db);
    this.proposals = new ProposalStore(db);
    this.history = new HistoryStore(db);
    this.escalationQueue = new DefaultEscalationQueueStore(db);
    this.pendingDeadlines = new DefaultPendingDeadlineStore(db);
  }

  static async create({
    database,
  }: {
    database: DatabaseService;
  }): Promise<DatabaseOwnershipStore> {
    const client = await database.getClient();

    if (!database.migrations?.skip) {
      await client.migrate.latest({ directory: migrationsDir });
    }

    return new DatabaseOwnershipStore(client);
  }

  // ── Ownership email digest ─────────────────────────────────────────────────

  async listPendingProposalsForEmail() {
    return this.db('ownership_proposals')
      .join(
        'ownership_entities',
        'ownership_proposals.entity_id',
        'ownership_entities.id',
      )
      .where('ownership_proposals.status', 'pending')
      .where('ownership_proposals.proposed_owner_ref', 'like', 'group:%')
      .whereNotIn('ownership_entities.current_status', ['closed'])
      .select(
        'ownership_proposals.proposed_owner_ref as team_ref',
        'ownership_entities.current_check',
        'ownership_entities.entity_kind',
      );
  }

  async hasEmailBeenSentThisPeriod(
    teamRef: string,
    periodKey: string,
  ): Promise<boolean> {
    const row = await this.db('ownership_email_sends')
      .where({ team_ref: teamRef, period_key: periodKey })
      .first();
    return Boolean(row);
  }

  async recordEmailSent(teamRef: string, periodKey: string): Promise<void> {
    await this.db('ownership_email_sends').insert({
      team_ref: teamRef,
      period_key: periodKey,
      sent_at: new Date(),
    });
  }

  // ── Stats ──────────────────────────────────────────────────────────────────

  async getDashboardStats() {
    const [entityStats, proposalStats] = await Promise.all([
      this.entities.getStats(),
      this.proposals.getStats(),
    ]);
    return { ...entityStats, ...proposalStats };
  }

  getStatsForOwners(owners: string[], escalationActorRef?: string) {
    return this.entities.getStatsForOwners(owners, escalationActorRef);
  }

  countActiveEscalationsForActor(actorRef: string) {
    return this.entities.countActiveEscalationsForActor(actorRef);
  }

  // ── Scans ──────────────────────────────────────────────────────────────────

  createScan(input?: CreateScanInput) {
    return this.scans.createScan(input);
  }
  completeScan(id: string, input: CompleteScanInput) {
    return this.scans.completeScan(id, input);
  }
  failScan(id: string, errorMessage: string, durationMs: number) {
    return this.scans.failScan(id, errorMessage, durationMs);
  }
  failStaleScans() {
    return this.scans.failStaleScans();
  }
  getScan(id: string) {
    return this.scans.getScan(id);
  }
  listScans(limit?: number, filter?: ScanFilter) {
    return this.scans.listScans(limit, filter);
  }

  // ── Entities ───────────────────────────────────────────────────────────────

  createEntity(input: CreateEntityInput) {
    return this.entities.createEntity(input);
  }
  updateEntityLastScanned(id: string, scanId: string, repo?: ScmRepoRef) {
    return this.entities.updateEntityLastScanned(id, scanId, repo);
  }
  acceptEntity(
    id: string,
    acceptedBy: string,
    resolutionType: ResolutionType,
    expectedVersion: number,
  ) {
    return this.entities.acceptEntity(
      id,
      acceptedBy,
      resolutionType,
      expectedVersion,
    );
  }
  reopenEntity(id: string, expectedVersion: number) {
    return this.entities.reopenEntity(id, expectedVersion);
  }
  updateAssignee(id: string, assignedTo: string | null) {
    return this.entities.updateAssignee(id, assignedTo);
  }
  markEntityToArchive(
    id: string,
    markedBy: string,
    assigneeRef: string,
    expectedVersion: number,
  ) {
    return this.entities.markEntityToArchive(
      id,
      markedBy,
      assigneeRef,
      expectedVersion,
    );
  }
  closeEntity(
    id: string,
    closedBy: string,
    resolutionType: ResolutionType,
    expectedVersion: number,
  ) {
    return this.entities.closeEntity(
      id,
      closedBy,
      resolutionType,
      expectedVersion,
    );
  }
  setEntityEscalated(id: string, expectedVersion: number) {
    return this.entities.setEntityEscalated(id, expectedVersion);
  }
  setEntityUnresolved(id: string, expectedVersion: number) {
    return this.entities.setEntityUnresolved(id, expectedVersion);
  }
  getActiveEntityByRef(entityRef: string) {
    return this.entities.getActiveEntityByRef(entityRef);
  }
  getEntityById(id: string) {
    return this.entities.getEntityById(id);
  }
  listActiveEntitiesForReconciliation() {
    return this.entities.listActiveEntitiesForReconciliation();
  }
  listEntitiesForPrReconciliation(checkedBefore: Date) {
    return this.entities.listEntitiesForPrReconciliation(checkedBefore);
  }
  countPrStatusesForAccepted() {
    return this.entities.countPrStatusesForAccepted();
  }
  listEntities(filter?: EntityFilter, pagination?: PaginationOptions) {
    return this.entities.listEntities(filter, pagination);
  }

  // ── Proposals ──────────────────────────────────────────────────────────────

  createProposal(input: CreateProposalInput) {
    return this.proposals.createProposal(input);
  }
  getProposal(id: string) {
    return this.proposals.getProposal(id);
  }
  listProposalsByEntity(entityId: string) {
    return this.proposals.listProposalsByEntity(entityId);
  }
  listActiveProposalsByEntity(entityId: string) {
    return this.proposals.listActiveProposalsByEntity(entityId);
  }
  listCancellableProposalsByEntity(entityId: string) {
    return this.proposals.listCancellableProposalsByEntity(entityId);
  }
  deletePossibleOwnersByEntity(entityId: string) {
    return this.proposals.deletePossibleOwnersByEntity(entityId);
  }
  updateProposalStatus(
    id: string,
    status: ProposalStatus,
    extra?: { respondedAt?: Date; responseNote?: string; notifiedAt?: Date },
  ) {
    return this.proposals.updateProposalStatus(id, status, extra);
  }
  refreshNotifiedAt(id: string, notifiedAt: Date) {
    return this.proposals.refreshNotifiedAt(id, notifiedAt);
  }
  listProposalsNeedingReminder(reminderAfterDays: number) {
    return this.proposals.listProposalsNeedingReminder(reminderAfterDays);
  }
  listProposalsForOwners(ownerRefs: string[], statuses?: ProposalStatus[]) {
    return this.proposals.listProposalsByOwners(ownerRefs, statuses);
  }
  listPendingProposalIdsForOwner(ownerRef: string) {
    return this.proposals.listPendingProposalIdsForOwner(ownerRef);
  }
  listAllProposals(
    pagination?: PaginationOptions,
    filter?: { status?: ProposalStatus[]; search?: string },
  ) {
    return this.proposals.listAllProposals(pagination, filter);
  }

  // ── History ────────────────────────────────────────────────────────────────

  appendHistory(input: AppendHistoryInput) {
    return this.history.appendHistory(input);
  }
  listHistory(entityId: string) {
    return this.history.listHistory(entityId);
  }
  getLatestHistoryAction(entityId: string, action: HistoryAction) {
    return this.history.getLatestHistoryAction(entityId, action);
  }
  getLatestHistoryActionIn(
    entityId: string,
    actions: readonly HistoryAction[],
  ) {
    return this.history.getLatestHistoryActionIn(entityId, actions);
  }
  getRejectedActors(entityId: string) {
    return this.history.getRejectedActors(entityId);
  }

  // ── Escalation queue read accessor (fix B) ─────────────────────────

  async findActiveQueueEntry(
    entityId: string,
  ): Promise<EscalationQueueEntryRow | null> {
    const row = await this.escalationQueue.findActiveEntry(entityId);
    return row ?? null;
  }

  // ── Pending-deadlines read accessor ───────────────────────

  findExpiredDeadlines(
    now: Date,
    filter?: DeadlineTypeFilter,
  ): Promise<PendingDeadlineRow[]> {
    return this.pendingDeadlines.findExpiredDeadlines(now, filter);
  }

  // ── Transactions ───────────────────────────────────────────────────────────

  /** Open a Knex transaction, build transaction-scoped sub-stores, and pass them to `fn`. */
  withTransaction<T>(fn: (stores: TxStores) => Promise<T>): Promise<T> {
    return this.db.transaction(async trx => {
      const stores: TxStores = {
        scanStore: new ScanStore(trx),
        entityStore: new EntityStore(trx),
        proposalStore: new ProposalStore(trx),
        historyStore: new HistoryStore(trx),
        escalationQueueStore: new DefaultEscalationQueueStore(trx),
        pendingDeadlineStore: new DefaultPendingDeadlineStore(trx),
      };
      return fn(stores);
    });
  }
}
